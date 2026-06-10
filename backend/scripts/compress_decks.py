"""Recompress oversized images inside single-file PowerPoint decks so they fit
under the Office-Online embed size ceiling (and thus play animations).

For each presentation dir under <RECORDINGS_DIR>/presentations/<id>/ that has
EXACTLY ONE .pptx over the threshold, we:
  1. back up the original to <name>.orig.pptx (once),
  2. downscale every embedded image to <= MAX_DIM on its long edge and
     recompress (JPEG q=82; PNG optimized) — format preserved so the deck's
     relationship/content-type refs stay valid,
  3. rewrite the .pptx in place,
  4. delete the stale S3 embed-staging object so the next getEmbedUrl()
     re-uploads the smaller deck.

Idempotent: decks already under the threshold (or already backed up + small)
are skipped. Run inside the backend container (has Pillow + boto3 + settings).
"""
from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path

from PIL import Image

from app.config import settings

MAX_DIM = 1600          # long-edge cap; slides display ~1280-1920px
JPEG_QUALITY = 82
# Only touch media entries larger than this (small icons aren't worth it).
MIN_IMAGE_BYTES = 250 * 1024
THRESHOLD = 10 * 1024 * 1024  # Office viewer ceiling; self-contained constant
_EMBED_PREFIX = "pptx-embed"


def _local_pptx_files(pres_dir: Path) -> list[Path]:
    return sorted(pres_dir.glob("*.pptx")) if pres_dir.exists() else []


def _embed_bucket() -> str | None:
    return settings.ANALYSIS_S3_BUCKET or None


def _embed_key(presentation_id: str, filename: str) -> str:
    return f"{_EMBED_PREFIX}/{presentation_id}/{Path(filename).name}"


def _s3_client():
    import boto3
    kwargs = {}
    if settings.AWS_REGION:
        kwargs["region_name"] = settings.AWS_REGION
    return boto3.client("s3", **kwargs)


def _has_alpha(img: Image.Image) -> bool:
    return img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)


def _process_media(name: str, data: bytes) -> tuple[str, bytes]:
    """Recompress one media entry. Returns (possibly-new-name, bytes).

    Opaque PNGs are converted to JPEG (huge win for photographic content) —
    the caller rewrites the .rels Targets to match the new extension. PNGs
    with transparency stay PNG. Everything is downscaled to MAX_DIM.
    """
    lower = name.lower()
    is_jpeg = lower.endswith((".jpg", ".jpeg"))
    is_png = lower.endswith(".png")
    if not (is_jpeg or is_png) or len(data) < MIN_IMAGE_BYTES:
        return name, data
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception:
        return name, data

    w, h = img.size
    scale = min(1.0, MAX_DIM / max(w, h))
    if scale < 1.0:
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)

    out = io.BytesIO()
    new_name = name
    try:
        if is_png and not _has_alpha(img):
            # Opaque PNG -> JPEG: rename media/imageN.png -> media/imageN.jpeg
            img.convert("RGB").save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True)
            new_name = name[: -len(".png")] + ".jpeg"
        elif is_png:
            img.save(out, format="PNG", optimize=True)
        else:
            img.convert("RGB").save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    except Exception:
        return name, data
    new = out.getvalue()
    if new_name == name and len(new) >= len(data):
        return name, data  # no improvement, no rename — keep original
    return new_name, new


def _compress_pptx(pptx: Path) -> tuple[int, int]:
    """Rewrite pptx in place: recompress media, convert opaque PNGs->JPEG, and
    fix up .rels Targets + [Content_Types].xml for any renamed media."""
    old_size = pptx.stat().st_size
    zin = zipfile.ZipFile(io.BytesIO(pptx.read_bytes()), "r")

    # Pass 1: process media, recording any basename renames (png -> jpeg).
    new_data: dict[str, bytes] = {}
    renames: dict[str, str] = {}  # old basename -> new basename
    for item in zin.infolist():
        name = item.filename
        data = zin.read(name)
        if name.lower().startswith("ppt/media/"):
            out_name, data = _process_media(name, data)
            if out_name != name:
                renames[name.split("/")[-1]] = out_name.split("/")[-1]
                name = out_name
        new_data[name] = data
    zin.close()

    # Pass 2: rewrite .rels Targets that point at renamed media, and ensure
    # [Content_Types].xml declares the jpeg extension.
    if renames:
        for fname in list(new_data.keys()):
            low = fname.lower()
            if low.endswith(".rels"):
                txt = new_data[fname].decode("utf-8", "ignore")
                for old_b, new_b in renames.items():
                    txt = txt.replace(f"media/{old_b}", f"media/{new_b}")
                new_data[fname] = txt.encode("utf-8")
            elif low.endswith("[content_types].xml"):
                txt = new_data[fname].decode("utf-8", "ignore")
                if 'Extension="jpeg"' not in txt and 'Extension="jpg"' not in txt:
                    inject = '<Default Extension="jpeg" ContentType="image/jpeg"/>'
                    txt = txt.replace("</Types>", inject + "</Types>")
                new_data[fname] = txt.encode("utf-8")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in new_data.items():
            zout.writestr(name, data)
    out_bytes = buf.getvalue()
    pptx.write_bytes(out_bytes)
    return old_size, len(out_bytes)


def _clear_s3_staging(presentation_id: str, pptx_name: str) -> None:
    bucket = _embed_bucket()
    if not bucket:
        return
    key = _embed_key(presentation_id, pptx_name)
    try:
        client = _s3_client()
        client.delete_object(Bucket=bucket, Key=key)
        print(f"    cleared stale S3 staging s3://{bucket}/{key}")
    except Exception as e:  # noqa: BLE001
        print(f"    (could not clear S3 staging: {e})")


def main() -> None:
    root = Path(settings.RECORDINGS_DIR) / "presentations"
    if not root.exists():
        print(f"no presentations dir at {root}")
        return
    for pres_dir in sorted(root.iterdir()):
        if not pres_dir.is_dir():
            continue
        pid = pres_dir.name
        pptx_files = _local_pptx_files(pres_dir)
        if len(pptx_files) != 1:
            continue  # multi-file decks use the PNG path; don't bother
        pptx = pptx_files[0]
        size = pptx.stat().st_size
        if size <= THRESHOLD:
            continue
        print(f"{pid}: {pptx.name}  {size/1e6:.1f} MB  -> compressing")
        # NB: ".pptx.orig" (not ".orig.pptx") so the backup never matches the
        # "*.pptx" glob — otherwise it'd look like a 2-file (no-embed) deck.
        backup = pptx.parent / (pptx.name + ".orig")
        if not backup.exists():
            backup.write_bytes(pptx.read_bytes())
            print(f"    backed up original -> {backup.name}")
        old, new = _compress_pptx(pptx)
        print(f"    {old/1e6:.1f} MB -> {new/1e6:.1f} MB"
              f"  ({'UNDER' if new <= THRESHOLD else 'STILL OVER'} {THRESHOLD/1e6:.0f} MB limit)")
        _clear_s3_staging(pid, pptx.name)
    print("done.")


if __name__ == "__main__":
    sys.exit(main())
