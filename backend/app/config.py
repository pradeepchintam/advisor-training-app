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

    # AWS Polly voices (neural). Override per-deployment.
    POLLY_VOICE_FEMALE: str = "Joanna"
    POLLY_VOICE_MALE: str = "Matthew"
    POLLY_ENGINE: str = "neural"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
