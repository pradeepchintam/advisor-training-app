import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, require_advisor, require_advisor_or_admin
from app.database import get_db
from app.models import TrainingSession, User
from app.schemas import ClientPersona, SessionCreate, SessionDetail, SessionPublic
from app.services.persona_service import generate_persona_details
from app.services.storage_service import get_recording_path, get_recording_url, save_recording

router = APIRouter()


async def _fetch_client_image(gender: str) -> str:
    """Fetch a profile image URL from randomuser.me."""
    gender_param = "male" if gender.lower() == "male" else "female"
    url = f"https://randomuser.me/api/?gender={gender_param}&nat=us,gb,au&results=1"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                data = resp.json()
                return data["results"][0]["picture"]["large"]
    except Exception:
        pass
    # Fallback placeholder
    return f"https://ui-avatars.com/api/?name=Client&background=random&size=200"


async def _load_active_script_content(db: AsyncSession) -> str | None:
    from app.models import TrainingScript
    r = await db.execute(select(TrainingScript).where(TrainingScript.is_active == True))
    s = r.scalar_one_or_none()
    return s.content if s else None


async def _run_analysis(session_id: str) -> None:
    """Background task: run Claude analysis on the session."""
    from app.database import AsyncSessionLocal
    from app.services.claude_service import analyze_session

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(TrainingSession).where(TrainingSession.id == session_id)
        )
        session = result.scalar_one_or_none()
        if session is None:
            return
        try:
            script_content = await _load_active_script_content(db)
            analysis = await analyze_session(session, script_content=script_content)
            session.analysis = analysis
            await db.commit()
        except Exception as e:
            # Mark error but don't crash
            session.status = "error"
            await db.commit()


@router.get("", response_model=list[SessionPublic])
async def list_sessions(
    advisor_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_advisor_or_admin),
):
    query = select(TrainingSession).order_by(TrainingSession.started_at.desc())

    if current_user.role == "admin":
        if advisor_id:
            query = query.where(TrainingSession.advisor_id == advisor_id)
    else:
        query = query.where(TrainingSession.advisor_id == current_user.id)

    result = await db.execute(query)
    sessions = result.scalars().all()

    # Build advisor name lookup in one query
    advisor_ids = list({s.advisor_id for s in sessions})
    if advisor_ids:
        users_result = await db.execute(select(User).where(User.id.in_(advisor_ids)))
        advisor_map = {u.id: u.name for u in users_result.scalars().all()}
    else:
        advisor_map = {}

    return [
        SessionPublic(
            id=s.id,
            advisor_id=s.advisor_id,
            advisor_name=advisor_map.get(s.advisor_id),
            client_name=s.client_name,
            client_image_url=s.client_image_url,
            status=s.status,
            started_at=s.started_at,
            ended_at=s.ended_at,
            persona=ClientPersona(**s.persona),
            overall_score=s.analysis.get("overall_score") if s.analysis else None,
        )
        for s in sessions
    ]


@router.post("", response_model=SessionPublic, status_code=status.HTTP_201_CREATED)
async def create_session(
    payload: SessionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_advisor),
):
    persona = payload.persona

    # Generate a complete persona if needed
    if not persona.name or not persona.backstory:
        completed = generate_persona_details(persona.model_dump())
        persona = completed

    # Fetch client image
    image_url = await _fetch_client_image(persona.gender)

    session = TrainingSession(
        id=str(uuid.uuid4()),
        advisor_id=current_user.id,
        persona=persona.model_dump(),
        client_name=persona.name,
        client_image_url=image_url,
        status="active",
        conversation=[],
        started_at=datetime.now(timezone.utc),
    )
    db.add(session)
    await db.flush()
    await db.refresh(session)

    return SessionPublic(
        id=session.id,
        advisor_id=session.advisor_id,
        client_name=session.client_name,
        client_image_url=session.client_image_url,
        status=session.status,
        started_at=session.started_at,
        ended_at=session.ended_at,
        persona=ClientPersona(**session.persona),
    )


@router.get("/{session_id}", response_model=SessionDetail)
async def get_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_advisor_or_admin),
):
    result = await db.execute(
        select(TrainingSession).where(TrainingSession.id == session_id)
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    if current_user.role != "admin" and session.advisor_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    from app.schemas import ConversationMessage

    return SessionDetail(
        id=session.id,
        advisor_id=session.advisor_id,
        client_name=session.client_name,
        client_image_url=session.client_image_url,
        status=session.status,
        persona=ClientPersona(**session.persona),
        conversation=[ConversationMessage(**m) for m in (session.conversation or [])],
        recording_path=session.recording_path,
        analysis=session.analysis,
        started_at=session.started_at,
        ended_at=session.ended_at,
    )


@router.post("/{session_id}/end", response_model=dict)
async def end_session(
    session_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_advisor_or_admin),
):
    result = await db.execute(
        select(TrainingSession).where(TrainingSession.id == session_id)
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    if current_user.role != "admin" and session.advisor_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    # Idempotent: if session is still active, mark it completed.
    # If already completed (e.g. via WebSocket disconnect), just re-trigger analysis.
    if session.status == "active":
        session.status = "completed"
        session.ended_at = datetime.now(timezone.utc)
        await db.commit()
        msg = "Session ended. Analysis will be available shortly."
    elif session.status == "completed":
        msg = "Session was already completed. Re-running analysis."
    else:  # "error" or any other state
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot end session in status '{session.status}'",
        )

    # Kick off analysis in background
    background_tasks.add_task(_run_analysis, session_id)

    return {"message": msg, "session_id": session_id}


@router.get("/{session_id}/recording")
async def get_recording(
    session_id: str,
    request: Request,
    token: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    """
    Stream the recording file. Accepts auth via Authorization header OR ?token=<jwt>
    query parameter (since <video src=> tags cannot send custom headers).
    """
    from app.auth import decode_token

    # Resolve auth: prefer Authorization header, fall back to ?token=
    auth_header = request.headers.get("authorization", "")
    bearer_token: str | None = None
    if auth_header.lower().startswith("bearer "):
        bearer_token = auth_header.split(" ", 1)[1].strip()
    if not bearer_token:
        bearer_token = token

    if not bearer_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")

    try:
        payload = decode_token(bearer_token)
        user_id = payload.get("sub")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Invalid token: {e}")

    user_result = await db.execute(select(User).where(User.id == user_id))
    current_user = user_result.scalar_one_or_none()
    if current_user is None or not current_user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")

    result = await db.execute(
        select(TrainingSession).where(TrainingSession.id == session_id)
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    if current_user.role != "admin" and session.advisor_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    # When S3 is enabled, redirect the client to a short-lived presigned URL.
    presigned = get_recording_url(session_id)
    if presigned:
        return RedirectResponse(url=presigned, status_code=status.HTTP_302_FOUND)

    recording_path = get_recording_path(session_id)
    if recording_path is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No recording file found for session {session_id}. The advisor may not have uploaded one, or it was lost during a server restart.",
        )

    # Detect media type by sniffing first bytes — WebM video files start with the
    # EBML magic, but we can simplify by checking the filename or file content.
    from pathlib import Path as _P
    fpath = _P(recording_path)
    media_type = "video/webm"
    try:
        with open(recording_path, "rb") as fh:
            head = fh.read(128)
        # Both audio and video WebM share the EBML header; check for the Tracks
        # element with a TrackType of video (0x83 0x81 0x01) for video. Easier
        # heuristic: assume video if file is larger than ~1KB and the recording
        # extension/MIME hint says so.
        if b"V_VP" in head or b"V_AV" in head:
            media_type = "video/webm"
        elif b"A_OPUS" in head or b"A_VORBIS" in head:
            media_type = "audio/webm"
    except OSError:
        pass

    return FileResponse(
        path=recording_path,
        media_type=media_type,
        filename=f"session_{session_id}{fpath.suffix or '.webm'}",
    )


@router.post("/{session_id}/recording", response_model=dict)
async def upload_recording(
    session_id: str,
    recording: UploadFile,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_advisor_or_admin),
):
    result = await db.execute(
        select(TrainingSession).where(TrainingSession.id == session_id)
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    if current_user.role != "admin" and session.advisor_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    content = await recording.read()
    filename = recording.filename or f"recording_{session_id}.webm"
    path = await save_recording(session_id, content, filename)

    session.recording_path = path
    await db.commit()

    return {"message": "Recording uploaded successfully", "path": path}


@router.get("/{session_id}/analysis", response_model=dict)
async def get_analysis(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_advisor_or_admin),
):
    result = await db.execute(
        select(TrainingSession).where(TrainingSession.id == session_id)
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    if current_user.role != "admin" and session.advisor_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    if session.analysis:
        return session.analysis

    if session.status == "active":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Session is still active. End it first.",
        )

    # Run analysis now (synchronously for this request)
    from app.services.claude_service import analyze_session

    try:
        script_content = await _load_active_script_content(db)
        analysis = await analyze_session(session, script_content=script_content)
        session.analysis = analysis
        await db.commit()
        return analysis
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Analysis failed: {str(e)}",
        )
