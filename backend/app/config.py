from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    DATABASE_URL: str = "postgresql+asyncpg://postgres:password@localhost:5432/trajan_training"
    SECRET_KEY: str = "change-this-in-production-must-be-at-least-32-characters"
    ANTHROPIC_API_KEY: str = ""
    RECORDINGS_DIR: str = "./recordings"
    ADMIN_EMAIL: str = "admin@trajanwealth.com"
    ADMIN_PASSWORD: str = "TempAdmin123!"
    # S3-backed recordings. Leave S3_BUCKET empty to fall back to local disk (dev).
    S3_BUCKET: str = ""
    AWS_REGION: str = ""
    PRESIGNED_URL_TTL: int = 300  # seconds

    # Bucket used for staging media that AWS Transcribe / vision frames consume.
    # Distinct from S3_BUCKET so you can keep recordings local while still
    # uploading short-lived analysis artifacts to S3.
    ANALYSIS_S3_BUCKET: str = ""
    # Max minutes of audio we'll re-transcribe (safety limit; cost guard).
    TRANSCRIBE_MAX_MINUTES: int = 60
    # Polling cadence for AWS Transcribe job status.
    TRANSCRIBE_POLL_SECONDS: float = 3.0
    # Number of evenly-spaced video frames to sample for vision analysis.
    VISION_FRAME_COUNT: int = 6

    # --- PowerPoint Online embed (animated slides) ----------------------
    # Microsoft's public Office viewer (view.officeapps.live.com) fetches the
    # deck over HTTPS and renders it WITH animations/transitions. It has a hard
    # size ceiling (~10 MB) — past it the iframe renders blank. We only hand
    # back an embed URL when the deck fits; otherwise the caller falls back to
    # the pre-rendered per-slide PNGs (no animations, but always reliable).
    PPTX_EMBED_MAX_BYTES: int = 10 * 1024 * 1024  # 10 MiB
    # Public origin of THIS app (e.g. https://trainer.jupiterlead.com). The
    # Office viewer fetches the deck from <base>/api/public/decks/<id>/deck.pptx
    # — it must be a publicly-reachable URL. Empty => embed disabled (PNG only),
    # which is the correct default for local dev (no public URL for Microsoft).
    APP_PUBLIC_BASE_URL: str = ""

    # --- Amazon Nova Sonic (speech-to-speech) ---------------------------
    # Native S2S model on Bedrock: mic audio in -> agent audio out, LLM
    # built in (no STT->Claude->TTS cascade). Uses the bidirectional
    # streaming API via the experimental aws-sdk-bedrock-runtime SDK.
    # Credentials come from the standard AWS env vars / instance role.
    NOVA_SONIC_MODEL_ID: str = "amazon.nova-sonic-v1:0"
    NOVA_SONIC_REGION: str = "us-east-1"
    # Default output voice; per-session we map persona gender -> a preset
    # Nova voice (matthew/tiffany/amy). Age is steered via the system prompt.
    NOVA_SONIC_VOICE_ID: str = "matthew"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
