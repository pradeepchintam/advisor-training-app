import asyncio
import shutil
from pathlib import Path
from typing import Optional

import aiofiles
import boto3
from botocore.exceptions import ClientError

from app.config import settings


def _s3_enabled() -> bool:
    return bool(settings.S3_BUCKET)


def _s3_client():
    kwargs = {}
    if settings.AWS_REGION:
        kwargs["region_name"] = settings.AWS_REGION
    return boto3.client("s3", **kwargs)


def _session_dir(session_id: str) -> Path:
    return Path(settings.RECORDINGS_DIR) / session_id


def _s3_key(session_id: str, filename: str) -> str:
    return f"{session_id}/{filename}"


async def save_recording(session_id: str, file_content: bytes, filename: str) -> str:
    """Persist the recording. Returns a stable identifier (local path or s3://bucket/key)."""
    if _s3_enabled():
        key = _s3_key(session_id, filename)
        content_type = "video/webm" if filename.endswith(".webm") else "application/octet-stream"
        client = _s3_client()
        await asyncio.to_thread(
            client.put_object,
            Bucket=settings.S3_BUCKET,
            Key=key,
            Body=file_content,
            ContentType=content_type,
        )
        return f"s3://{settings.S3_BUCKET}/{key}"

    session_dir = _session_dir(session_id)
    session_dir.mkdir(parents=True, exist_ok=True)
    file_path = session_dir / filename
    async with aiofiles.open(file_path, "wb") as f:
        await f.write(file_content)
    return str(file_path.resolve())


def get_recording_path(session_id: str) -> Optional[str]:
    """Local-disk path to the recording, or None. Returns None when S3 is enabled."""
    if _s3_enabled():
        return None
    session_dir = _session_dir(session_id)
    if not session_dir.exists():
        return None
    for entry in session_dir.iterdir():
        if entry.is_file():
            return str(entry.resolve())
    return None


def get_recording_url(session_id: str) -> Optional[str]:
    """Presigned S3 URL for the recording, or None when S3 is disabled / object missing."""
    if not _s3_enabled():
        return None
    client = _s3_client()
    prefix = f"{session_id}/"
    try:
        resp = client.list_objects_v2(Bucket=settings.S3_BUCKET, Prefix=prefix, MaxKeys=1)
    except ClientError:
        return None
    contents = resp.get("Contents", [])
    if not contents:
        return None
    return client.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.S3_BUCKET, "Key": contents[0]["Key"]},
        ExpiresIn=settings.PRESIGNED_URL_TTL,
    )


def delete_recording(session_id: str) -> None:
    if _s3_enabled():
        client = _s3_client()
        try:
            resp = client.list_objects_v2(Bucket=settings.S3_BUCKET, Prefix=f"{session_id}/")
            objs = [{"Key": o["Key"]} for o in resp.get("Contents", [])]
            if objs:
                client.delete_objects(Bucket=settings.S3_BUCKET, Delete={"Objects": objs})
        except ClientError:
            pass
        return
    session_dir = _session_dir(session_id)
    if session_dir.exists():
        shutil.rmtree(session_dir)
