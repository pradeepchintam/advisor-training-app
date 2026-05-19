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

    # AWS Polly voices (neural). Override per-deployment.
    POLLY_VOICE_FEMALE: str = "Joanna"
    POLLY_VOICE_MALE: str = "Matthew"
    POLLY_ENGINE: str = "neural"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
