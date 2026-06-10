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

    # TTS — ElevenLabs Flash v2.5 streaming. There's no fallback; if
    # ELEVENLABS_API_KEY is unset the /api/tts/stream endpoint returns
    # 502 and the session surfaces an error rather than silently
    # degrading to a worse voice.
    ELEVENLABS_API_KEY: str = ""
    ELEVENLABS_BASE_URL: str = "https://api.elevenlabs.io/v1"
    # Flash v2.5 = low-latency model (~75ms vendor TTFA). For higher
    # naturalness at the cost of latency, set to `eleven_multilingual_v2`
    # for offline/non-realtime content.
    ELEVENLABS_MODEL_ID: str = "eleven_flash_v2_5"

    # --- ElevenLabs Conversational AI (Agents) trial ---------------------
    # Separate key with convai_read/convai_write scopes (the TTS key above
    # is text-to-speech only). Kept distinct so the trial never disturbs the
    # production streaming-TTS path. Only used by the /api/agent-trial path.
    ELEVENLABS_CONVAI_API_KEY: str = ""
    ELEVENLABS_TRIAL_AGENT_ID: str = ""

    # --- Simli realtime avatar trial -------------------------------------
    # Photoreal talking-head avatar driven by an external (ElevenLabs) audio
    # stream. Only used by the /api/simli-trial path. Key stays server-side;
    # the browser gets a short-lived session token, never the key.
    SIMLI_API_KEY: str = ""
    SIMLI_BASE_URL: str = "https://api.simli.ai"

    # --- Amazon Nova Sonic (speech-to-speech) trial ---------------------
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
