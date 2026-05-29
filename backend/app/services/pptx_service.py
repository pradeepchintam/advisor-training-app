"""Convert uploaded PowerPoint decks into per-slide PNG images.

Pipeline: .pptx --(libreoffice --headless --convert-to pdf)--> .pdf --(pdf2image)--> PNGs.

The PNGs live under <RECORDINGS_DIR>/presentations/<presentation_id>/slide-<N>.png
(N is 1-indexed). One thumbnail per slide. We keep the original .pptx around in
case we need to re-render later.
"""
from __future__ import annotations

import asyncio
import shutil
import subprocess
from pathlib import Path

from app.config import settings


def _presentations_root() -> Path:
    root = Path(settings.RECORDINGS_DIR) / "presentations"
    root.mkdir(parents=True, exist_ok=True)
    return root


def presentation_dir(presentation_id: str) -> Path:
    return _presentations_root() / presentation_id


def slide_path(presentation_id: str, slide_number: int) -> Path:
    """1-indexed slide path. Returns the path whether or not the file exists."""
    return presentation_dir(presentation_id) / f"slide-{slide_number}.png"


def _libreoffice_to_pdf(pptx_path: Path, out_dir: Path) -> Path:
    """Run headless LibreOffice to convert pptx → pdf. Returns the pdf path.

    LibreOffice's headless mode is fragile when two processes share the same
    user profile dir. We pass an isolated `-env:UserInstallation=...` so each
    invocation gets its own profile.
    """
    profile = out_dir / "_lo_profile"
    profile.mkdir(exist_ok=True)
    cmd = [
        "libreoffice",
        f"-env:UserInstallation=file://{profile}",
        "--headless",
        "--convert-to", "pdf",
        "--outdir", str(out_dir),
        str(pptx_path),
    ]
    # 10-minute per-file ceiling. Big decks with embedded images/video can
    # take several minutes; 180s was tripping legitimate conversions on small
    # EC2 instances.
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(
            f"libreoffice convert failed (rc={result.returncode}): "
            f"stdout={result.stdout!r} stderr={result.stderr!r}"
        )
    # LibreOffice names the output <basename>.pdf in --outdir
    pdf = out_dir / (pptx_path.stem + ".pdf")
    if not pdf.exists():
        raise RuntimeError(f"libreoffice did not produce {pdf}")
    # Best-effort: clean up the profile dir so it doesn't accumulate
    shutil.rmtree(profile, ignore_errors=True)
    return pdf


def _pdf_to_pngs(pdf_path: Path, out_dir: Path) -> int:
    """Convert each page of pdf_path → slide-<N>.png in out_dir. Returns slide count."""
    from pdf2image import convert_from_path  # imported lazily — needs poppler

    images = convert_from_path(str(pdf_path), dpi=150, fmt="png")
    for i, img in enumerate(images, start=1):
        img.save(out_dir / f"slide-{i}.png", "PNG")
    return len(images)


def _merge_pdfs(pdfs: list[Path], out_path: Path) -> None:
    """Concatenate PDFs in order. Uses pypdf (already a backend dependency)."""
    from pypdf import PdfReader, PdfWriter

    writer = PdfWriter()
    for p in pdfs:
        reader = PdfReader(str(p))
        for page in reader.pages:
            writer.add_page(page)
    with open(out_path, "wb") as fh:
        writer.write(fh)


def _convert_sync(
    files: list[tuple[bytes, str]], presentation_id: str
) -> tuple[int, Path]:
    """Synchronous worker.

    Persists each uploaded .pptx, converts each to PDF, merges them in order,
    then renders the merged PDF to slide-N.png images.

    Returns (slide_count, primary_pptx_path).
    """
    pres_dir = presentation_dir(presentation_id)
    pres_dir.mkdir(parents=True, exist_ok=True)

    saved_pptx: list[Path] = []
    intermediate_pdfs: list[Path] = []
    try:
        for idx, (data, original_filename) in enumerate(files, start=1):
            # Prefix with order so the file system listing matches merge order.
            base = Path(original_filename).name or "deck.pptx"
            safe_name = f"{idx:02d}-{base}" if len(files) > 1 else base
            pptx_path = pres_dir / safe_name
            pptx_path.write_bytes(data)
            saved_pptx.append(pptx_path)

            pdf = _libreoffice_to_pdf(pptx_path, pres_dir)
            intermediate_pdfs.append(pdf)

        if len(intermediate_pdfs) == 1:
            merged_pdf = intermediate_pdfs[0]
            owns_merged = False
        else:
            merged_pdf = pres_dir / "combined.pdf"
            _merge_pdfs(intermediate_pdfs, merged_pdf)
            owns_merged = True

        count = _pdf_to_pngs(merged_pdf, pres_dir)
        if owns_merged:
            merged_pdf.unlink(missing_ok=True)
    finally:
        # Drop intermediate per-file PDFs; the rendered PNGs are the canonical
        # serving format. We keep the original .pptx files in case we ever
        # need to re-render.
        for p in intermediate_pdfs:
            try:
                if p.exists():
                    p.unlink()
            except OSError:
                pass

    primary = saved_pptx[0] if saved_pptx else pres_dir / "deck.pptx"
    return count, primary


async def convert_and_store(
    files: list[tuple[bytes, str]] | tuple[bytes, str],
    presentation_id: str,
    legacy_filename: str | None = None,
) -> tuple[Path, int, Path]:
    """Persist one or more .pptx files and render the combined deck to PNGs.

    Accepts either a list of (bytes, filename) tuples (new multi-file form) or
    a single (bytes, filename) tuple for backward compatibility with callers
    that haven't moved to the multi-file API.

    Returns (presentation_dir, slide_count, primary_pptx_path).
    """
    # Normalize to a list
    if isinstance(files, tuple) and len(files) == 2 and isinstance(files[0], (bytes, bytearray)):
        file_list = [files]  # legacy single-tuple form
    elif isinstance(files, (bytes, bytearray)) and legacy_filename is not None:
        # Oldest form: convert_and_store(bytes, id, filename)
        file_list = [(bytes(files), legacy_filename)]
    else:
        file_list = list(files)  # type: ignore[arg-type]

    count, primary = await asyncio.to_thread(_convert_sync, file_list, presentation_id)
    return presentation_dir(presentation_id), count, primary


def get_slide_bytes(presentation_id: str, slide_number: int) -> bytes | None:
    p = slide_path(presentation_id, slide_number)
    if not p.exists():
        return None
    return p.read_bytes()


def delete_presentation_files(presentation_id: str) -> None:
    d = presentation_dir(presentation_id)
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)


# ---------------------------------------------------------------------------
# PDF script attachment
# ---------------------------------------------------------------------------

def script_pdf_path(presentation_id: str) -> Path:
    return presentation_dir(presentation_id) / "script.pdf"


def _extract_pdf_text(pdf_bytes: bytes) -> str:
    """Extract plain text from a PDF using pypdf. Returns "" on failure."""
    import io

    try:
        from pypdf import PdfReader
    except Exception:  # pragma: no cover — dependency missing
        return ""

    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        parts: list[str] = []
        for page in reader.pages:
            txt = page.extract_text() or ""
            if txt.strip():
                parts.append(txt.strip())
        return "\n\n".join(parts).strip()
    except Exception:
        return ""


def store_script_pdf(
    presentation_id: str, pdf_bytes: bytes, original_filename: str
) -> tuple[str, str, str]:
    """Persist the script PDF next to the deck and extract its text.

    Returns (stored_path, original_filename, extracted_text).
    """
    pres_dir = presentation_dir(presentation_id)
    pres_dir.mkdir(parents=True, exist_ok=True)
    dst = script_pdf_path(presentation_id)
    dst.write_bytes(pdf_bytes)
    text = _extract_pdf_text(pdf_bytes)
    safe_name = Path(original_filename).name or "script.pdf"
    return str(dst), safe_name, text


def get_script_pdf_bytes(presentation_id: str) -> bytes | None:
    p = script_pdf_path(presentation_id)
    if not p.exists():
        return None
    return p.read_bytes()


def delete_script_pdf(presentation_id: str) -> None:
    p = script_pdf_path(presentation_id)
    if p.exists():
        p.unlink(missing_ok=True)
