"""WebSocket handler for a REAL training session driven by Amazon Nova Sonic.

This is the Nova-mode counterpart to the cascade `/ws/session/{id}` handler in
main.py. It is selected per-session via `TrainingSession.voice_mode == "nova_sonic"`.

Design goals:
  • Reuse the exact same auth/validation/persistence as the cascade path, so
    recording + post-session scoring work UNCHANGED (scoring reads
    `session.conversation`, which we populate identically).
  • Map Nova's event stream onto the SAME frontend message types the cascade
    sends (`transcript_final`, `client_response_start/chunk/end`,
    `auto_interrupt`), plus binary 24kHz PCM frames for playback.

Flow:
  browser mic 16kHz PCM (binary)  ->  nova.send_audio()
  nova events:
    user_transcript  -> append advisor turn + persist; send transcript_final
    assistant_text   -> client_response_start (first) + client_response_chunk
    turn_complete    -> client_response_end; append client turn + persist
    audio (24kHz)    -> websocket.send_bytes()  (frontend plays it)
    interrupted      -> auto_interrupt; reset assistant accumulator
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.services import nova_sonic_service as nova

logger = logging.getLogger("trajan.nova_session")


async def handle_nova_session(websocket: WebSocket, session_id: str, token: str) -> None:
    from app.auth import decode_token
    from app.models import TrainingSession, User
    from app.schemas import ClientPersona

    # --- auth (mirrors /ws/session) ---
    try:
        payload = decode_token(token)
        user_id = payload.get("sub")
    except Exception:
        await websocket.close(code=4001, reason="Invalid token")
        return

    if not nova.is_available():
        await websocket.accept()
        await websocket.send_json({"type": "error", "message": "Nova Sonic SDK not installed."})
        await websocket.close(code=1011)
        return

    await websocket.accept()

    # --- load + validate session (mirrors /ws/session) ---
    async with AsyncSessionLocal() as db:
        user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
        if user is None or not user.is_active:
            await websocket.send_json({"type": "error", "message": "User not found or inactive"})
            await websocket.close(code=4003)
            return
        session = (
            await db.execute(select(TrainingSession).where(TrainingSession.id == session_id))
        ).scalar_one_or_none()
        if session is None:
            await websocket.send_json({"type": "error", "message": "Session not found"})
            await websocket.close(code=4004)
            return
        if user.role != "admin" and session.advisor_id != user.id:
            await websocket.send_json({"type": "error", "message": "Access denied"})
            await websocket.close(code=4003)
            return
        if session.status != "active":
            await websocket.send_json({"type": "error", "message": f"Session is already {session.status}"})
            await websocket.close(code=4004)
            return

        persona = ClientPersona(**session.persona)
        conversation: list[dict] = list(session.conversation or [])

        await websocket.send_json({
            "type": "connected",
            "message": f"Connected to Nova session with {persona.name}",
            "client_name": persona.name,
            "client_image_url": session.client_image_url,
            "engage_client": True,
            "voice_mode": "nova_sonic",
        })

        # --- open Nova ---
        primary_gender = getattr(persona, "gender", None)
        nova_sess = nova.NovaSonicSession(
            system_prompt=nova.build_nova_persona_prompt(persona),
            voice_id=nova.pick_voice(primary_gender),
        )
        try:
            await nova_sess.start()
        except Exception as e:  # noqa: BLE001
            logger.exception("Nova start failed")
            await websocket.send_json({"type": "error", "message": f"Nova start failed: {e}"})
            await websocket.close(code=1011)
            return

        send_lock = asyncio.Lock()
        stop = asyncio.Event()
        # Accumulates assistant text for the current turn so we persist one
        # client message per turn (matching the cascade's behavior).
        assistant_buf = {"text": "", "started": False}

        async def safe_send_json(payload: dict) -> None:
            if stop.is_set():
                return
            async with send_lock:
                try:
                    await websocket.send_json(payload)
                except Exception:
                    stop.set()

        async def safe_send_bytes(data: bytes) -> None:
            if stop.is_set():
                return
            async with send_lock:
                try:
                    await websocket.send_bytes(data)
                except Exception:
                    stop.set()

        async def persist() -> None:
            session.conversation = list(conversation)
            await db.commit()

        async def finalize_turn() -> None:
            text = assistant_buf["text"].strip()
            assistant_buf["text"] = ""
            assistant_buf["started"] = False
            if not text:
                return
            ts = datetime.now(timezone.utc).isoformat()
            await safe_send_json({"type": "client_response_end", "text": text, "timestamp": ts})
            conversation.append({"role": "client", "text": text, "timestamp": ts})
            await persist()

        # --- Nova -> client pump ---
        async def pump() -> None:
            try:
                async for ev in nova_sess.events():
                    if stop.is_set():
                        break
                    if ev.type == "audio":
                        await safe_send_bytes(ev.audio)
                    elif ev.type == "user_transcript":
                        if ev.text.strip():
                            ts = datetime.now(timezone.utc).isoformat()
                            conversation.append({"role": "advisor", "text": ev.text, "timestamp": ts})
                            await persist()
                            await safe_send_json({"type": "transcript_final", "text": ev.text})
                    elif ev.type == "assistant_text":
                        if not assistant_buf["started"]:
                            assistant_buf["started"] = True
                            await safe_send_json({"type": "client_response_start"})
                        assistant_buf["text"] += ev.text
                        await safe_send_json({"type": "client_response_chunk", "text": ev.text})
                    elif ev.type == "turn_complete":
                        await finalize_turn()
                    elif ev.type == "interrupted":
                        assistant_buf["text"] = ""
                        assistant_buf["started"] = False
                        await safe_send_json({"type": "auto_interrupt"})
                    elif ev.type == "error":
                        await safe_send_json({"type": "error", "message": ev.text})
            except WebSocketDisconnect:
                stop.set()
            except Exception as e:  # noqa: BLE001
                logger.info("nova session pump ended: %s", e)
                stop.set()

        pump_task = asyncio.create_task(pump())

        # --- client -> Nova loop ---
        try:
            while not stop.is_set():
                evt = await websocket.receive()
                if evt.get("type") == "websocket.disconnect":
                    break
                if evt.get("bytes") is not None:
                    await nova_sess.send_audio(evt["bytes"])
                elif evt.get("text") is not None:
                    if '"end_session"' in evt["text"] or '"end"' in evt["text"]:
                        break
        except WebSocketDisconnect:
            pass
        except Exception as e:  # noqa: BLE001
            logger.info("nova session client loop ended: %s", e)
        finally:
            stop.set()
            # Flush any in-progress assistant turn into the transcript.
            try:
                await finalize_turn()
            except Exception:
                pass
            await nova_sess.close()
            pump_task.cancel()
            try:
                await pump_task
            except (asyncio.CancelledError, Exception):
                pass
            try:
                await persist()
            except Exception:
                pass
            try:
                await websocket.close()
            except Exception:
                pass
