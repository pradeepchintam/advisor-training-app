"""AWS Transcribe Streaming wrapper used by the live session WebSocket.

This is the **live** counterpart to `transcription_service.py` (which does
post-session bulk re-transcription). It opens a single Transcribe stream per
session, accepts PCM audio chunks as they come in, and yields transcript
events the WS handler can forward to the frontend.

Two consumers:
  • partial transcripts → frontend renders interim text live AND, during
    client TTS, server fires auto_interrupt.
  • final transcripts (Transcribe's IsPartial=False) → the WS handler kicks
    off the Claude stream as if the user had pressed "Stop Talking".

Audio format expected:
  • 16-bit PCM (linear), little-endian
  • 16000 Hz sample rate
  • mono

Lazily imports amazon_transcribe so a missing dep doesn't break startup.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import AsyncIterator, Optional

from app.config import settings

logger = logging.getLogger("trajan.transcribe_streaming")


@dataclass
class TranscriptEvent:
    """One transcript update emitted to the WS handler."""
    text: str
    is_partial: bool


class LiveTranscriber:
    """Per-session Transcribe streaming session.

    Usage (inside the WS handler):

        async with LiveTranscriber(language_code="en-US") as t:
            # writer task feeds raw PCM bytes:
            await t.send_audio(pcm_chunk)
            # reader task consumes transcript events:
            async for ev in t.events():
                if ev.is_partial: ...
                else: ...

    Tolerant of credential / region / SDK errors — `__aenter__` raises so the
    caller can fall back to the existing Web Speech path.
    """

    def __init__(
        self,
        *,
        language_code: str = "en-US",
        sample_rate_hz: int = 16000,
    ):
        self._language_code = language_code
        self._sample_rate_hz = sample_rate_hz
        self._stream = None
        self._handler_task: Optional[asyncio.Task] = None
        self._event_queue: asyncio.Queue[TranscriptEvent] = asyncio.Queue()
        self._closed = False

    async def __aenter__(self) -> "LiveTranscriber":
        # Lazy import so missing dep doesn't fail module load.
        from amazon_transcribe.client import TranscribeStreamingClient
        from amazon_transcribe.handlers import TranscriptResultStreamHandler

        client = TranscribeStreamingClient(region=settings.AWS_REGION or "us-east-1")
        self._stream = await client.start_stream_transcription(
            language_code=self._language_code,
            media_sample_rate_hz=self._sample_rate_hz,
            media_encoding="pcm",
        )

        # Capture self in the handler closure so we can forward events into our
        # asyncio.Queue.
        outer_self = self

        class _Handler(TranscriptResultStreamHandler):
            async def handle_transcript_event(self, transcript_event):
                results = transcript_event.transcript.results
                for r in results:
                    if not r.alternatives:
                        continue
                    text = r.alternatives[0].transcript or ""
                    if not text.strip():
                        continue
                    await outer_self._event_queue.put(
                        TranscriptEvent(text=text, is_partial=r.is_partial)
                    )

        handler = _Handler(self._stream.output_stream)
        # Spawn the handler task. It runs until the stream is closed.
        self._handler_task = asyncio.create_task(handler.handle_events())
        return self

    async def send_audio(self, pcm_chunk: bytes) -> None:
        if self._closed or self._stream is None:
            return
        try:
            await self._stream.input_stream.send_audio_event(audio_chunk=pcm_chunk)
        except Exception as e:  # noqa: BLE001
            logger.warning("Transcribe send_audio failed: %s", e)

    async def events(self) -> AsyncIterator[TranscriptEvent]:
        """Yield transcript events as they arrive. Exits when close() is called."""
        while not self._closed:
            try:
                ev = await asyncio.wait_for(self._event_queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            yield ev

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._stream is not None:
            try:
                await self._stream.input_stream.end_stream()
            except Exception:
                pass
        if self._handler_task is not None:
            try:
                await asyncio.wait_for(self._handler_task, timeout=2.0)
            except (asyncio.TimeoutError, Exception):
                self._handler_task.cancel()

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()


def is_available() -> bool:
    """Cheap check used by the WS handler to decide whether to enable the
    real-time path. Falls back to Web Speech if False."""
    try:
        import amazon_transcribe  # noqa: F401
        return True
    except ImportError:
        return False
