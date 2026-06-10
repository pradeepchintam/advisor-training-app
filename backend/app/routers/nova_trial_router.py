"""Amazon Nova Sonic — native speech-to-speech trial (LOCAL TRIAL).

Isolated spike: one live client (no couple) powered end-to-end by Nova Sonic.
The browser streams mic PCM (16kHz) over the WebSocket; Nova streams the
client's spoken reply (24kHz) plus live transcripts back. No STT->Claude->TTS
cascade — the agent lives inside the model.

Persona is fully configurable per the user's non-negotiable: gender drives the
preset Nova voice, while name / age / temperament / scenario are woven into the
system prompt (Nova has no age voice dial, so age is steered behaviourally).

  WS /api/nova-trial/ws?token=<JWT>&gender=female&age=senior&name=Margaret&persona=<desc>

  client -> server:
    • binary frames  = raw PCM16 mono 16kHz mic audio
    • text  {"type":"end"} = end the session
  server -> client:
    • binary frames  = raw PCM16 mono 24kHz agent audio (play it)
    • text  {"type":"ready"|"user_transcript"|"assistant_text"|"interrupted"
             |"turn_complete"|"error", ...}
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import settings
from app.services import nova_sonic_service as nova

logger = logging.getLogger("trajan.nova_trial")
router = APIRouter()


def _build_system_prompt(name: str, gender: str, age: str, persona: str) -> str:
    age_label = {
        "young_adult": "in your late 20s",
        "middle_aged": "in your late 40s",
        "senior": "in your late 60s",
        "elderly": "in your 80s",
    }.get((age or "").lower(), "middle-aged")
    pace = ""
    if (age or "").lower() in ("senior", "elderly"):
        pace = (" Speak a little slowly and deliberately, the way an older "
                "person often does, and take your time.")
    extra = f"\n\nBackground for your character:\n{persona.strip()}" if persona.strip() else ""
    return (
        f"You are role-playing as a prospective wealth-management CLIENT named "
        f"{name}, a {gender} person {age_label}. The HUMAN you are talking to is "
        f"a financial ADVISOR who is practicing a client meeting. You are NOT the "
        f"advisor — you are the client they are meeting with.\n\n"
        f"Stay fully in character as {name}. Be realistic: warm but a little "
        f"cautious about money, ask the kinds of questions a real client would, "
        f"share concerns, and react naturally to what the advisor says. Keep your "
        f"replies fairly short and conversational, the way people actually talk "
        f"out loud — usually one to three sentences. Never break character, never "
        f"narrate actions, and never mention that you are an AI.{pace}{extra}"
    )


@router.websocket("/ws")
async def nova_ws(websocket: WebSocket):
    from app.auth import decode_token

    token = websocket.query_params.get("token", "")
    try:
        decode_token(token)
    except Exception:
        await websocket.close(code=4001, reason="Invalid token")
        return

    if not nova.is_available():
        await websocket.accept()
        await websocket.send_json({
            "type": "error",
            "message": "Nova Sonic SDK not installed on the server.",
        })
        await websocket.close(code=1011)
        return

    gender = websocket.query_params.get("gender", "female")
    age = websocket.query_params.get("age", "middle_aged")
    name = websocket.query_params.get("name", "Margaret")
    persona = websocket.query_params.get("persona", "")

    await websocket.accept()

    session = nova.NovaSonicSession(
        system_prompt=_build_system_prompt(name, gender, age, persona),
        voice_id=nova.pick_voice(gender),
    )
    try:
        await session.start()
    except Exception as e:  # noqa: BLE001
        logger.exception("Nova start failed")
        await websocket.send_json({"type": "error", "message": f"Nova start failed: {e}"})
        await websocket.close(code=1011)
        return

    await websocket.send_json({"type": "ready", "voice": session._voice_id})

    stop = asyncio.Event()

    async def pump_nova_to_client():
        try:
            async for ev in session.events():
                if stop.is_set():
                    break
                if ev.type == "audio":
                    await websocket.send_bytes(ev.audio)
                else:
                    payload = {"type": ev.type}
                    if ev.text:
                        payload["text"] = ev.text
                    await websocket.send_json(payload)
        except WebSocketDisconnect:
            stop.set()
        except Exception as e:  # noqa: BLE001
            logger.info("nova->client pump ended: %s", e)
            stop.set()

    pump_task = asyncio.create_task(pump_nova_to_client())

    try:
        while not stop.is_set():
            evt = await websocket.receive()
            if evt.get("type") == "websocket.disconnect":
                break
            if "bytes" in evt and evt["bytes"] is not None:
                await session.send_audio(evt["bytes"])
            elif "text" in evt and evt["text"] is not None:
                # Only control message we expect is {"type":"end"}.
                if '"end"' in evt["text"]:
                    break
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        logger.info("nova client loop ended: %s", e)
    finally:
        stop.set()
        await session.close()
        pump_task.cancel()
        try:
            await pump_task
        except (asyncio.CancelledError, Exception):
            pass
        try:
            await websocket.close()
        except Exception:
            pass
