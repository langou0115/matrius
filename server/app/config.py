from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "development"
    app_url: str = "http://localhost:8000"
    cors_origins: str = ""
    log_level: str = "INFO"

    database_url: str = "postgresql+asyncpg://matrius:matrius@localhost:5432/matrius"
    redis_url: str = "redis://localhost:6379/0"

    rustfs_endpoint: str = "http://localhost:9000"
    rustfs_access_key: str = ""
    rustfs_secret_key: str = ""
    rustfs_bucket: str = "matrius"
    rustfs_region: str = "us-east-1"

    openserp_url: str = "http://localhost:7000"
    openserp_proxy_url: str = ""
    openserp_proxy_tag: str = ""

    auth_session_ttl_seconds: int = 604800
    initial_admin_username: str = ""
    initial_admin_password: str = ""

    max_upload_bytes: int = 20 * 1024 * 1024
    storage_quota_bytes: int = 512 * 1024 * 1024
    fetch_max_chars: int = 50000

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
