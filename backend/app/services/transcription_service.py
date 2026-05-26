"""AWS Transcribe wrapper used by the post-session analyzer.

Given a recording (local path or `s3://` URI), this module:

  1. Uploads the audio to ANALYSIS_S3_BUCKET if it's not already in S3.
  2. Kicks off an AWS Transcribe job with speaker labels.
  3. Polls until the job is COMPLETED or FAILED.
  4. Fetches the result JSON and returns a normalized dict with:

       {
         "transcript": "Full ASR transcript",
         "items": [{"start": float, "end": float, "text": str, "speaker": str}],
         "duration_seconds": float,
         "speakers": {"spk_0": "advisor", "spk_1": "client"}  # best-effort guess
       }

It only runs when ANALYSIS_S3_BUCKET is configured. Callers should treat the
return value as best-effort and fall back to session.conversation if this
raises.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import boto3
import httpx
from botocore.exceptions import ClientError

from app.config import settings

logger = logging.getLogger(__name__)


def _s3_client():
    kwargs = {}
    if settings.AWS_REGION:
        kwargs["region_name"] = settings.AWS_REGION
    return boto3.client("s3", **kwargs)


def _transcribe_client():
    kwargs = {}
    if settings.AWS_REGION:
        kwargs["region_name"] = settings.AWS_REGION
    return boto3.client("transcribe", **kwargs)


def _parse_s3_uri(uri: str) -> tuple[str, str]:
    p = urlparse(uri)
    return p.netloc, p.path.lstrip("/")


async def _upload_recording_to_analysis_bucket(local_path: str, session_id: str) -> tuple[str, str]:
    """Push a local recording into the analysis bucket. Returns (bucket, key)."""
    bucket = settings.ANALYSIS_S3_BUCKET
    key = f"transcribe-input/{session_id}/{uuid.uuid4().hex}-{Path(local_path).name}"
    client = _s3_client()
    suffix = Path(local_path).suffix.lower()
    content_type = "video/webm" if suffix == ".webm" else "audio/webm"

    def _put():
        with open(local_path, "rb") as fh:
            client.put_object(Bucket=bucket, Key=key, Body=fh, ContentType=content_type)

    await asyncio.to_thread(_put)
    return bucket, key


def _media_format_for(uri_or_path: str) -> str:
    """AWS Transcribe MediaFormat. WebM is supported natively."""
    s = uri_or_path.lower()
    if s.endswith(".webm"):
        return "webm"
    if s.endswith(".mp4") or s.endswith(".m4a"):
        return "mp4"
    if s.endswith(".mp3"):
        return "mp3"
    if s.endswith(".wav"):
        return "wav"
    if s.endswith(".ogg") or s.endswith(".oga"):
        return "ogg"
    if s.endswith(".flac"):
        return "flac"
    return "webm"  # safe default for our recorder


async def _ensure_recording_in_s3(recording_path: str, session_id: str) -> tuple[str, str]:
    """Return (bucket, key) for the recording, uploading from local disk if needed."""
    if recording_path.startswith("s3://"):
        bucket, key = _parse_s3_uri(recording_path)
        return bucket, key
    return await _upload_recording_to_analysis_bucket(recording_path, session_id)


async def transcribe_recording(recording_path: str, session_id: str) -> dict | None:
    """End-to-end re-transcription. Returns None if transcription is disabled
    or the recording is unavailable. Raises on AWS errors so the caller can
    decide whether to swallow them.
    """
    if not settings.ANALYSIS_S3_BUCKET:
        logger.info("ANALYSIS_S3_BUCKET not set; skipping re-transcription")
        return None

    bucket, key = await _ensure_recording_in_s3(recording_path, session_id)
    media_uri = f"s3://{bucket}/{key}"
    media_format = _media_format_for(key)

    job_name = f"trajan-{session_id}-{uuid.uuid4().hex[:8]}"
    client = _transcribe_client()

    def _start():
        client.start_transcription_job(
            TranscriptionJobName=job_name,
            Media={"MediaFileUri": media_uri},
            MediaFormat=media_format,
            LanguageCode="en-US",
            Settings={
                "ShowSpeakerLabels": True,
                "MaxSpeakerLabels": 2,
            },
        )

    await asyncio.to_thread(_start)
    logger.info("Started Transcribe job %s for session %s", job_name, session_id)

    # Poll for completion. Bound by TRANSCRIBE_MAX_MINUTES * 60 / poll_interval.
    deadline = time.time() + settings.TRANSCRIBE_MAX_MINUTES * 60

    def _get():
        return client.get_transcription_job(TranscriptionJobName=job_name)

    transcript_uri: str | None = None
    while time.time() < deadline:
        resp = await asyncio.to_thread(_get)
        status = resp["TranscriptionJob"]["TranscriptionJobStatus"]
        if status == "COMPLETED":
            transcript_uri = resp["TranscriptionJob"]["Transcript"]["TranscriptFileUri"]
            break
        if status == "FAILED":
            failure = resp["TranscriptionJob"].get("FailureReason", "(no reason)")
            raise RuntimeError(f"Transcribe job {job_name} failed: {failure}")
        await asyncio.sleep(settings.TRANSCRIBE_POLL_SECONDS)

    if not transcript_uri:
        raise RuntimeError(f"Transcribe job {job_name} timed out")

    # Fetch the result JSON.
    async with httpx.AsyncClient(timeout=30.0) as http:
        r = await http.get(transcript_uri)
        r.raise_for_status()
        data = r.json()

    # Best-effort cleanup of the Transcribe job (doesn't bill if left behind).
    def _cleanup():
        try:
            client.delete_transcription_job(TranscriptionJobName=job_name)
        except ClientError:
            pass

    asyncio.create_task(asyncio.to_thread(_cleanup))

    return _normalize_aws_result(data)


def _normalize_aws_result(data: dict) -> dict:
    """Flatten AWS Transcribe's nested JSON into our internal shape."""
    results = data.get("results", {})
    transcripts = results.get("transcripts", [])
    full_text = " ".join(t.get("transcript", "") for t in transcripts).strip()

    items_in = results.get("items", [])
    speaker_segments = results.get("speaker_labels", {}).get("segments", [])

    # Build a speaker lookup: each speaker segment carries items with start_time → label.
    item_speaker: dict[str, str] = {}
    for seg in speaker_segments:
        spk = seg.get("speaker_label", "spk_0")
        for it in seg.get("items", []):
            st = it.get("start_time")
            if st is not None:
                item_speaker[st] = spk

    normalized_items = []
    duration = 0.0
    for it in items_in:
        if it.get("type") != "pronunciation":
            continue
        alt = (it.get("alternatives") or [{}])[0]
        text = alt.get("content", "")
        start_s = it.get("start_time")
        end_s = it.get("end_time")
        if start_s is None or end_s is None:
            continue
        start_f = float(start_s)
        end_f = float(end_s)
        duration = max(duration, end_f)
        normalized_items.append(
            {
                "start": start_f,
                "end": end_f,
                "text": text,
                "speaker": item_speaker.get(start_s, "spk_0"),
            }
        )

    # Best-effort speaker mapping: the speaker who talked first is usually the
    # advisor (they kick off the conversation). The caller can re-map if needed.
    speakers: dict[str, str] = {}
    if normalized_items:
        first_speaker = normalized_items[0]["speaker"]
        speakers[first_speaker] = "advisor"
        for it in normalized_items:
            if it["speaker"] != first_speaker:
                speakers[it["speaker"]] = "client"
                break

    return {
        "transcript": full_text,
        "items": normalized_items,
        "duration_seconds": duration,
        "speakers": speakers,
    }


async def cleanup_analysis_artifacts(session_id: str) -> None:
    """Best-effort delete of transcribe-input/<session_id>/* objects."""
    if not settings.ANALYSIS_S3_BUCKET:
        return
    client = _s3_client()
    prefix = f"transcribe-input/{session_id}/"

    def _delete():
        resp = client.list_objects_v2(Bucket=settings.ANALYSIS_S3_BUCKET, Prefix=prefix)
        objs = [{"Key": o["Key"]} for o in resp.get("Contents", [])]
        if objs:
            client.delete_objects(
                Bucket=settings.ANALYSIS_S3_BUCKET, Delete={"Objects": objs}
            )

    try:
        await asyncio.to_thread(_delete)
    except ClientError as e:
        logger.warning("Failed to clean up analysis artifacts: %s", e)


# ---------------------------------------------------------------------------
# For callers without a stored local file: download from s3 to /tmp.
# ---------------------------------------------------------------------------

async def download_recording_to_tmp(recording_path: str) -> Optional[str]:
    """Return a local filesystem path for the recording, downloading from S3
    if needed. Returns None on failure. Caller is responsible for unlinking."""
    if recording_path.startswith("s3://"):
        bucket, key = _parse_s3_uri(recording_path)
        client = _s3_client()
        tmp = Path("/tmp") / f"recording-{uuid.uuid4().hex}{Path(key).suffix}"

        def _dl():
            client.download_file(bucket, key, str(tmp))

        try:
            await asyncio.to_thread(_dl)
        except ClientError as e:
            logger.warning("Failed to download recording from S3: %s", e)
            return None
        return str(tmp)
    if Path(recording_path).exists():
        return recording_path
    return None
