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
        # One-sided practice mode when False: the client never speaks, we just
        # record + transcribe the advisor's walkthrough for scoring.
        engage_client: bool = bool(getattr(session, "engage_client", False))

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
            "engage_client": engage_client,
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

        # -------------------------------------------------------------------
        # Multiplexed audio + control loop.
        #
        # Two paths converge into the same Claude-streaming code:
        #
        #   1) Real-time: the frontend AudioWorklet sends PCM16 frames as
        #      binary WS messages. We pipe them into AWS Transcribe Streaming.
        #      Partial transcripts trigger barge-in; finals trigger Claude.
        #
        #   2) Legacy / fallback: the frontend sends {type:"advisor_message",
        #      text:"..."} JSON (Web Speech path or text input). Same Claude
        #      stream is invoked.
        #
        # While Claude is generating, any non-empty partial transcript fires
        # an auto_interrupt to the frontend AND cancels the in-flight Claude
        # task — server-side barge-in.
        # -------------------------------------------------------------------
        import asyncio as _asyncio
        from app.services.claude_service import stream_client_response
        from app.services.transcribe_streaming_service import (
            LiveTranscriber,
            is_available as _transcribe_available,
        )

        send_lock = _asyncio.Lock()
        is_client_speaking = {"value": False}  # boxed mutable for closures
        claude_task: dict[str, _asyncio.Task | None] = {"task": None}
        transcriber: LiveTranscriber | None = None
        transcript_task: _asyncio.Task | None = None

        async def safe_send_json(payload: dict) -> None:
            try:
                async with send_lock:
                    await websocket.send_json(payload)
            except Exception:
                pass

        async def handle_advisor_message(text: str) -> None:
            """Run the Claude stream for one advisor utterance and persist the
            results. Cancellable — auto_interrupt cancels via claude_task."""
            text = (text or "").strip()
            if not text:
                return
            ts = datetime.now(timezone.utc).isoformat()
            conversation.append({"role": "advisor", "text": text, "timestamp": ts})

            # One-sided practice mode: record the advisor's speech for scoring
            # but the client stays silent — no Claude call, no TTS.
            if not engage_client:
                session.conversation = list(conversation)
                await db.commit()
                return

            start_ts = datetime.now(timezone.utc).isoformat()
            is_client_speaking["value"] = True
            await safe_send_json({"type": "client_response_start", "timestamp": start_ts})

            async def _forward(chunk: str) -> None:
                await safe_send_json({"type": "client_response_chunk", "text": chunk})

            async def _announce_speaker(who: str) -> None:
                # Couple personas only — tells the frontend whether this turn
                # belongs to the primary or the spouse so TTS picks the right
                # voice. Fired once per turn, BEFORE the first text chunk.
                await safe_send_json({"type": "active_speaker", "speaker": who})

            client_response = ""
            try:
                client_response = await stream_client_response(
                    persona=persona,
                    conversation_history=conversation[:-1],
                    advisor_message=text,
                    questionnaire_topics=questionnaire_topics,
                    on_chunk=_forward,
                    on_speaker=_announce_speaker,
                )
            except _asyncio.CancelledError:
                # Server-side barge-in: advisor started talking again.
                is_client_speaking["value"] = False
                await safe_send_json({"type": "client_response_cancelled"})
                raise
            except Exception as e:  # noqa: BLE001
                is_client_speaking["value"] = False
                await safe_send_json({"type": "error", "message": f"AI error: {e}"})
                return

            client_ts = datetime.now(timezone.utc).isoformat()
            conversation.append(
                {"role": "client", "text": client_response, "timestamp": client_ts}
            )
            session.conversation = list(conversation)
            await db.commit()
            is_client_speaking["value"] = False
            await safe_send_json({
                "type": "client_response_end",
                "text": client_response,
                "timestamp": client_ts,
            })

        async def consume_transcripts(tx: LiveTranscriber) -> None:
            """Read transcript events from Transcribe and route them:
              • partial → forward to frontend (for live interim display).
                If client is currently speaking, this also triggers barge-in.
              • final → forward + kick off Claude (cancelling any in-flight
                Claude task that the new utterance is interrupting).
            """
            async for ev in tx.events():
                if ev.is_partial:
                    await safe_send_json({"type": "transcript_partial", "text": ev.text})
                    # Barge-in: the advisor started speaking during the client's reply.
                    if is_client_speaking["value"]:
                        cur = claude_task["task"]
                        if cur and not cur.done():
                            cur.cancel()
                        await safe_send_json({"type": "auto_interrupt"})
                        is_client_speaking["value"] = False
                else:
                    await safe_send_json({"type": "transcript_final", "text": ev.text})
                    # Cancel any still-running Claude stream just to be safe,
                    # then kick off a new one with this utterance.
                    cur = claude_task["task"]
                    if cur and not cur.done():
                        cur.cancel()
                        try:
                            await cur
                        except (_asyncio.CancelledError, Exception):
                            pass
                    claude_task["task"] = _asyncio.create_task(handle_advisor_message(ev.text))

        async def keepalive_loop() -> None:
            """Send a JSON ping every 25s so intermediate proxies don't
            close the WebSocket as idle. The frontend ignores `type=ping`
            messages — they're purely there to keep the connection alive.

            Without this, sessions were observed dropping at ~5 minutes,
            consistent with some proxy/AWS NAT idle timeout (300s).
            """
            while True:
                try:
                    await _asyncio.sleep(25)
                    await safe_send_json({"type": "ping"})
                except _asyncio.CancelledError:
                    raise
                except Exception:
                    # Connection probably already dead; exit silently.
                    return

        ping_task = _asyncio.create_task(keepalive_loop())

        try:
            while True:
                evt = await websocket.receive()
                # FastAPI's WS receive() returns a dict with one of:
                #   {"type": "websocket.receive", "text": "..."}      (JSON control)
                #   {"type": "websocket.receive", "bytes": b"..."}    (PCM audio frame)
                #   {"type": "websocket.disconnect", ...}
                if evt.get("type") == "websocket.disconnect":
                    raise WebSocketDisconnect()

                # ---- AUDIO FRAME PATH ----
                audio_bytes = evt.get("bytes")
                if audio_bytes:
                    # Lazy-init the transcriber on the first audio frame so a
                    # text-only session never pays the Transcribe cost.
                    if transcriber is None and _transcribe_available():
                        try:
                            transcriber = LiveTranscriber(language_code="en-US")
                            await transcriber.__aenter__()
                            transcript_task = _asyncio.create_task(consume_transcripts(transcriber))
                        except Exception as e:  # noqa: BLE001
                            transcriber = None
                            await safe_send_json({
                                "type": "transcribe_unavailable",
                                "message": f"Live transcription unavailable: {e}",
                            })
                    if transcriber is not None:
                        await transcriber.send_audio(audio_bytes)
                    continue

                # ---- TEXT (control) PATH ----
                raw = evt.get("text")
                if not raw:
                    continue
                try:
                    data = json.loads(raw)
                    msg = WSMessage(**data)
                except Exception:
                    await safe_send_json({"type": "error", "message": "Invalid message format"})
                    continue

                if msg.type == "end_session":
                    session.status = "completed"
                    session.ended_at = datetime.now(timezone.utc)
                    session.conversation = conversation
                    session.slide_events = slide_events
                    await db.commit()
                    await safe_send_json({"type": "session_ended"})
                    break

                if msg.type == "advisor_slide_change":
                    slide_num = data.get("slide_number")
                    if not isinstance(slide_num, int) or slide_num < 1:
                        await safe_send_json({"type": "error", "message": "Invalid slide_number"})
                        continue
                    event = {
                        "slide_number": slide_num,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                    pres_id = data.get("presentation_id")
                    if isinstance(pres_id, str) and pres_id:
                        event["presentation_id"] = pres_id
                    deck_label = data.get("deck_label")
                    if isinstance(deck_label, str) and deck_label:
                        event["deck_label"] = deck_label
                    slide_events.append(event)
                    session.slide_events = list(slide_events)
                    await db.commit()
                    await safe_send_json({"type": "slide_changed", "slide_number": slide_num})
                    continue

                if msg.type == "advisor_message":
                    # Legacy / Web Speech / text-input path. Same Claude code.
                    if not msg.text or not msg.text.strip():
                        await safe_send_json({"type": "error", "message": "Empty message"})
                        continue
                    cur = claude_task["task"]
                    if cur and not cur.done():
                        cur.cancel()
                        try:
                            await cur
                        except (_asyncio.CancelledError, Exception):
                            pass
                    claude_task["task"] = _asyncio.create_task(handle_advisor_message(msg.text))
                    continue

                if msg.type == "advisor_interrupt":
                    # Client UI requested an immediate barge-in.
                    cur = claude_task["task"]
                    if cur and not cur.done():
                        cur.cancel()
                    is_client_speaking["value"] = False
                    await safe_send_json({"type": "auto_interrupt"})
                    continue

        except WebSocketDisconnect as e:
            # Log the disconnect cause so future "session stopped at X
            # minutes" reports can be diagnosed. WebSocketDisconnect.code
            # tells us if it was a clean close (1000), going-away (1001),
            # protocol error (1002), abnormal close (1006), etc.
            import logging as _logging
            _logger = _logging.getLogger("trajan.ws")
            elapsed = (datetime.now(timezone.utc) - session.started_at).total_seconds() if session.started_at else 0
            _logger.warning(
                "WS disconnected session=%s after %.1fs code=%s reason=%r",
                session.id, elapsed, getattr(e, "code", "?"), getattr(e, "reason", ""),
            )
            # Mark session as completed on disconnect if still active
            if session.status == "active":
                session.status = "completed"
                session.ended_at = datetime.now(timezone.utc)
                session.conversation = conversation
                session.slide_events = slide_events
                await db.commit()
        except Exception as e:  # noqa: BLE001
            # Catch-all so the cleanup in `finally` still runs. Without
            # this, an unhandled exception from inside the receive() loop
            # propagates up and the session is left in active=true forever.
            import logging as _logging
            _logger = _logging.getLogger("trajan.ws")
            elapsed = (datetime.now(timezone.utc) - session.started_at).total_seconds() if session.started_at else 0
            _logger.exception(
                "WS unexpected error session=%s after %.1fs: %s",
                session.id, elapsed, e,
            )
            if session.status == "active":
                session.status = "completed"
                session.ended_at = datetime.now(timezone.utc)
                session.conversation = conversation
                session.slide_events = slide_events
                try:
                    await db.commit()
                except Exception:
                    pass
        finally:
            # Stop the keepalive ping task.
            if "ping_task" in locals() and ping_task and not ping_task.done():
                ping_task.cancel()
            # Clean up live tasks so they don't leak.
            cur = claude_task["task"]
            if cur and not cur.done():
                cur.cancel()
            if transcript_task and not transcript_task.done():
                transcript_task.cancel()
            if transcriber is not None:
                try:
                    await transcriber.close()
                except Exception:
                    pass


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
