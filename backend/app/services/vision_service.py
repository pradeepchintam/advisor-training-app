"""Sample a handful of frames from the session video and use Claude vision to
read body language / engagement / setting. Soft signal — used only to flag
obvious issues (advisor on phone, not facing camera, distracting background).
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

import anthropic

try:
    import imageio_ffmpeg
except Exception:  # pragma: no cover
    imageio_ffmpeg = None  # type: ignore

try:
    from PIL import Image
except Exception:  # pragma: no cover
    Image = None  # type: ignore

from app.config import settings

logger = logging.getLogger(__name__)

_client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)


def _ffmpeg_exe() -> str | None:
    if imageio_ffmpeg is None:
        return None
    try:
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as e:  # pragma: no cover
        logger.warning("imageio_ffmpeg unavailable: %s", e)
        return None


def _probe_duration_seconds(ffmpeg: str, src: str) -> float | None:
    """Use ffmpeg to print the input duration; parse from stderr."""
    try:
        # -hide_banner keeps output tighter; we expect "Duration: HH:MM:SS.MS"
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-i", src],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        logger.warning("ffmpeg probe failed: %s", e)
        return None

    text = proc.stderr
    m = re.search(r"Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    if not m:
        return None
    h, mnt, s = m.groups()
    return int(h) * 3600 + int(mnt) * 60 + float(s)


def _extract_frame(ffmpeg: str, src: str, ts: float, dst: str) -> bool:
    """Pull a single JPEG frame at the given second."""
    try:
        proc = subprocess.run(
            [
                ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                "-ss", f"{ts:.2f}",
                "-i", src,
                "-frames:v", "1",
                "-q:v", "5",  # mid-quality JPEG keeps payload reasonable
                dst,
            ],
            capture_output=True,
            timeout=60,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        logger.warning("ffmpeg frame extract failed: %s", e)
        return False
    return proc.returncode == 0 and Path(dst).exists()


def _downscale_jpeg(path: str, max_dim: int = 768) -> None:
    """Cap the largest dimension to keep base64 payloads small."""
    if Image is None:
        return
    try:
        with Image.open(path) as img:
            img.thumbnail((max_dim, max_dim))
            img.save(path, "JPEG", quality=80)
    except Exception as e:  # pragma: no cover
        logger.warning("PIL downscale failed: %s", e)


async def analyze_video(local_recording_path: str) -> Optional[dict]:
    """Sample frames and ask Claude vision for an engagement read.

    Returns None gracefully when prerequisites are missing (no ffmpeg, no
    video stream, etc). Raises only on Claude API errors so the caller can
    decide whether to swallow them.
    """
    ffmpeg = _ffmpeg_exe()
    if not ffmpeg:
        logger.info("ffmpeg unavailable; skipping vision pass")
        return None
    if not Path(local_recording_path).exists():
        logger.info("recording not found at %s; skipping vision pass", local_recording_path)
        return None

    duration = _probe_duration_seconds(ffmpeg, local_recording_path)
    if not duration or duration < 5:
        logger.info("recording too short or no duration; skipping vision pass")
        return None

    # Sample N evenly-spaced frames, skipping the very first/last seconds.
    n = max(2, int(settings.VISION_FRAME_COUNT))
    pad = min(2.0, duration * 0.05)
    timestamps = [
        pad + (duration - 2 * pad) * (i / (n - 1)) for i in range(n)
    ]

    frames_b64: list[str] = []
    with tempfile.TemporaryDirectory(prefix="trajan-frames-") as tmp:
        for i, ts in enumerate(timestamps):
            dst = os.path.join(tmp, f"frame-{i}.jpg")
            if not _extract_frame(ffmpeg, local_recording_path, ts, dst):
                continue
            _downscale_jpeg(dst)
            with open(dst, "rb") as fh:
                frames_b64.append(base64.standard_b64encode(fh.read()).decode("ascii"))

    if not frames_b64:
        logger.info("no frames extracted; skipping vision pass")
        return None

    # Build a multimodal message: instructions + frames + JSON instruction.
    content: list[dict] = [
        {
            "type": "text",
            "text": (
                "You are reviewing a recorded fiduciary advisor's training "
                "session. The frames below are sampled evenly across the "
                "session. Evaluate ONLY what you can see in the frames — body "
                "language, eye contact direction, posture, framing, lighting, "
                "and obvious distractions (advisor on phone, multiple people, "
                "background TV, etc). Do not invent details you can't see."
            ),
        }
    ]
    for b64 in frames_b64:
        content.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": b64,
                },
            }
        )
    content.append(
        {
            "type": "text",
            "text": (
                "Respond with VALID JSON only — no markdown fences — using "
                "this schema exactly:\n"
                "{\n"
                '  "score": <float 1-10 or null if uninterpretable>,\n'
                '  "feedback": "<2-3 sentence assessment grounded in the frames>",\n'
                '  "observations": ["<short bullet>", "<short bullet>"],\n'
                '  "concerns": ["<flag if distracting/unprofessional, or empty list>"]\n'
                "}"
            ),
        }
    )

    def _call() -> str:
        resp = _client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=600,
            system="You are a coaching assistant scoring video presence. Be concise and concrete.",
            messages=[{"role": "user", "content": content}],
        )
        return resp.content[0].text

    raw = (await asyncio.to_thread(_call)).strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if m:
            try:
                return json.loads(m.group())
            except json.JSONDecodeError:
                pass
        logger.warning("vision response not parseable JSON: %s", raw[:200])
        return None
