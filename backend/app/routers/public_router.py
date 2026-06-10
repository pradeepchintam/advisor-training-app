"""Unauthenticated endpoints that must be reachable by THIRD PARTIES.

Currently just the PowerPoint deck served to Microsoft's Office Online viewer:
the viewer's servers fetch the .pptx over the public internet (they have no
session with our app), so this route has NO auth. Decks are addressed by their
opaque presentation UUID — anyone with the exact link can fetch the file, the
same exposure the old S3 presigned URLs had. Only single-file decks under the
embed size limit are served; anything else 404s (those use the PNG path and
are never embedded).
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse

from app.config import settings
from app.services.pptx_service import _local_pptx_files

router = APIRouter()

_PPTX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
)


@router.get("/decks/{presentation_id}/deck.pptx")
async def public_deck(presentation_id: str):
    """Stream the deck for the Office Online viewer. No auth by design.

    FileResponse handles HEAD + Range/206 automatically, which the viewer uses.
    """
    files = _local_pptx_files(presentation_id)
    # Only single-file decks are embeddable; multi-file decks are merged into a
    # PNG sequence and never embedded.
    if len(files) != 1:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Deck not available")
    deck = files[0]
    try:
        if deck.stat().st_size > settings.PPTX_EMBED_MAX_BYTES:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Deck too large to embed")
    except OSError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Deck not available")
    return FileResponse(
        path=str(deck),
        media_type=_PPTX_MEDIA_TYPE,
        filename="deck.pptx",
        content_disposition_type="inline",
        headers={"Cache-Control": "public, max-age=3600"},
    )
