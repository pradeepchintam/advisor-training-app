import logging
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

logging.getLogger("trajan").setLevel(logging.DEBUG)
logging.getLogger("trajan").addHandler(logging.StreamHandler())
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
# WebSocket endpoints
# ---------------------------------------------------------------------------
@app.websocket("/ws/nova/{session_id}")
async def nova_session_endpoint(websocket: WebSocket, session_id: str, token: str):
    """Nova Sonic native speech-to-speech for a real session (voice_mode=nova_sonic).

    Separate from /ws/session to keep the cascade handler untouched. Persists
    turns into session.conversation identically so recording + scoring are
    unchanged. See app/nova_session_ws.py.
    """
    from app.nova_session_ws import handle_nova_session
    await handle_nova_session(websocket, session_id, token)


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
