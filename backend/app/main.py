from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select

from app.config import settings
from app.database import AsyncSessionLocal, init_db
from app.routers.auth_router import router as auth_router
from app.routers.advisors_router import router as advisors_router
from app.routers.sessions_router import router as sessions_router
from app.routers.questionnaire_router import router as questionnaire_router
from app.routers.presentations_router import router as presentations_router
from app.routers.scripts_router import router as scripts_router
from app.routers.tts_router import router as tts_router
from app.routers.profiles_router import router as profiles_router
from app.routers.assignments_router import router as assignments_router

app = FastAPI(
    title="Trajan Wealth Advisor Trainer",
    version="1.0.0",
    description="AI-powered training platform for fiduciary wealth management advisors",
    redirect_slashes=False,
)

# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------
app.include_router(auth_router, prefix="/api/auth", tags=["auth"])
app.include_router(advisors_router, prefix="/api/advisors", tags=["advisors"])
app.include_router(sessions_router, prefix="/api/sessions", tags=["sessions"])
app.include_router(questionnaire_router, prefix="/api/questionnaire", tags=["questionnaire"])
app.include_router(presentations_router, prefix="/api/presentations", tags=["presentations"])
app.include_router(scripts_router, prefix="/api/scripts", tags=["scripts"])
app.include_router(tts_router, prefix="/api/tts", tags=["tts"])
app.include_router(profiles_router, prefix="/api/profiles", tags=["profiles"])
app.include_router(assignments_router, prefix="/api/assignments", tags=["assignments"])


# ---------------------------------------------------------------------------
# Persona options endpoint (for frontend dropdowns)
# ---------------------------------------------------------------------------
@app.get("/api/persona-options", tags=["persona"])
async def get_persona_options():
    from app.services.persona_service import PERSONA_OPTIONS
    return PERSONA_OPTIONS


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------
@app.websocket("/ws/session/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str, token: str):
    """
    Real-time conversation WebSocket.

    Query param: token=<JWT>

    Client sends JSON: {"type": "advisor_message", "text": "..."}
                  or: {"type": "end_session"}

    Server sends JSON: {"type": "client_response", "text": "...", "timestamp": "..."}
                  or: {"type": "session_ended"}
                  or: {"type": "error", "message": "..."}
    """
    from app.auth import decode_token
    from app.models import Presentation, Questionnaire, TrainingSession, User
    from app.schemas import ClientPersona, WSMessage
    from app.services.claude_service import simulate_client_response
    import json

    # Verify JWT
    try:
        payload = decode_token(token)
        user_id: str = payload.get("sub")
    except Exception:
        await websocket.close(code=4001, reason="Invalid token")
        return

    await websocket.accept()

    async with AsyncSessionLocal() as db:
        # Validate user
        user_result = await db.execute(select(User).where(User.id == user_id))
        user = user_result.scalar_one_or_none()
        if user is None or not user.is_active:
            await websocket.send_json({"type": "error", "message": "User not found or inactive"})
            await websocket.close(code=4003)
            return

        # Load session
        session_result = await db.execute(
            select(TrainingSession).where(TrainingSession.id == session_id)
        )
        session = session_result.scalar_one_or_none()
        if session is None:
            await websocket.send_json({"type": "error", "message": "Session not found"})
            await websocket.close(code=4004)
            return

        if user.role != "admin" and session.advisor_id != user.id:
            await websocket.send_json({"type": "error", "message": "Access denied"})
            await websocket.close(code=4003)
            return

        if session.status != "active":
            await websocket.send_json(
                {"type": "error", "message": f"Session is already {session.status}"}
            )
            await websocket.close(code=4004)
            return

        # Load questionnaire topics
        q_result = await db.execute(
            select(Questionnaire).where(Questionnaire.is_active == True)
        )
        questionnaire = q_result.scalar_one_or_none()
        questionnaire_topics: list[dict] = []
        if questionnaire and questionnaire.content:
            for category in questionnaire.content.get("categories", []):
                for topic in category.get("topics", []):
                    questionnaire_topics.append(topic)

        persona = ClientPersona(**session.persona)
        conversation: list[dict] = list(session.conversation or [])
        slide_events: list[dict] = list(session.slide_events or [])

        # Prefer the deck recorded on the session (so the slides match what the
        # analyzer will grade against). Fall back to whatever is active now.
        active_presentation = None
        if getattr(session, "presentation_id", None):
            pres_result = await db.execute(
                select(Presentation).where(Presentation.id == session.presentation_id)
            )
            active_presentation = pres_result.scalar_one_or_none()
        if active_presentation is None:
            pres_result = await db.execute(
                select(Presentation).where(Presentation.is_active == True)
            )
            active_presentation = pres_result.scalar_one_or_none()

        # Send welcome message
        await websocket.send_json({
            "type": "connected",
            "message": f"Connected to session with {persona.name}",
            "client_name": persona.name,
            "client_image_url": session.client_image_url,
            "presentation": (
                {
                    "id": active_presentation.id,
                    "title": active_presentation.title,
                    "slide_count": active_presentation.slide_count,
                }
                if active_presentation
                else None
            ),
        })

        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    data = json.loads(raw)
                    msg = WSMessage(**data)
                except Exception:
                    await websocket.send_json({"type": "error", "message": "Invalid message format"})
                    continue

                if msg.type == "end_session":
                    session.status = "completed"
                    session.ended_at = datetime.now(timezone.utc)
                    session.conversation = conversation
                    session.slide_events = slide_events
                    await db.commit()
                    await websocket.send_json({"type": "session_ended"})
                    break

                if msg.type == "advisor_slide_change":
                    slide_num = data.get("slide_number")
                    if not isinstance(slide_num, int) or slide_num < 1:
                        await websocket.send_json({"type": "error", "message": "Invalid slide_number"})
                        continue
                    event = {
                        "slide_number": slide_num,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                    # Optional: which deck this slide belongs to (third appts have 2 decks)
                    pres_id = data.get("presentation_id")
                    if isinstance(pres_id, str) and pres_id:
                        event["presentation_id"] = pres_id
                    deck_label = data.get("deck_label")
                    if isinstance(deck_label, str) and deck_label:
                        event["deck_label"] = deck_label
                    slide_events.append(event)
                    session.slide_events = list(slide_events)
                    await db.commit()
                    # Echo for client confirmation
                    await websocket.send_json({"type": "slide_changed", "slide_number": slide_num})
                    continue

                if msg.type == "advisor_message":
                    if not msg.text or not msg.text.strip():
                        await websocket.send_json({"type": "error", "message": "Empty message"})
                        continue

                    # Store advisor message
                    ts = datetime.now(timezone.utc).isoformat()
                    conversation.append({"role": "advisor", "text": msg.text, "timestamp": ts})

                    # Tell the frontend a streamed reply is starting so it can
                    # spin up a live message bubble + TTS sentence queue.
                    start_ts = datetime.now(timezone.utc).isoformat()
                    await websocket.send_json({
                        "type": "client_response_start",
                        "timestamp": start_ts,
                    })

                    # Stream the response. Each text chunk is forwarded to the
                    # WS as it arrives.
                    from app.services.claude_service import stream_client_response

                    async def _forward(chunk: str) -> None:
                        await websocket.send_json({
                            "type": "client_response_chunk",
                            "text": chunk,
                        })

                    try:
                        client_response = await stream_client_response(
                            persona=persona,
                            conversation_history=conversation[:-1],
                            advisor_message=msg.text,
                            questionnaire_topics=questionnaire_topics,
                            on_chunk=_forward,
                        )
                    except Exception as e:
                        await websocket.send_json(
                            {"type": "error", "message": f"AI error: {str(e)}"}
                        )
                        continue

                    # Persist the finalized client message.
                    client_ts = datetime.now(timezone.utc).isoformat()
                    conversation.append(
                        {"role": "client", "text": client_response, "timestamp": client_ts}
                    )
                    session.conversation = list(conversation)
                    await db.commit()

                    # End-of-stream marker (frontend reconciles full text).
                    await websocket.send_json({
                        "type": "client_response_end",
                        "text": client_response,
                        "timestamp": client_ts,
                    })

        except WebSocketDisconnect:
            # Mark session as completed on disconnect if still active
            if session.status == "active":
                session.status = "completed"
                session.ended_at = datetime.now(timezone.utc)
                session.conversation = conversation
                session.slide_events = slide_events
                await db.commit()


# ---------------------------------------------------------------------------
# Startup / shutdown
# ---------------------------------------------------------------------------
@app.on_event("startup")
async def startup_event():
    # Ensure recordings directory exists
    recordings_path = Path(settings.RECORDINGS_DIR)
    recordings_path.mkdir(parents=True, exist_ok=True)

    # Create DB tables and seed data
    await init_db()


@app.get("/health", tags=["health"])
async def health_check():
    return {"status": "healthy", "service": "Trajan Wealth Advisor Trainer"}
