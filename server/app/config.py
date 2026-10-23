from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "development"
    app_url: str = "http://localhost:8000"
    cors_origins: str = ""
    log_level: str = "INFO"

    # Everything persistent lives in DATA_DIR. The default is repo-local so a
    # plain `uv run` works without Docker; production mounts /data.
    database_url: str = "sqlite+aiosqlite:///./.data/dev.db"
    data_dir: str = "./.data"
    sqlite_busy_timeout_ms: int = 30000

    # In-process cache and rate limiting. Exactly one uvicorn worker may run,
    # because this state is not shared between processes.
    cache_max_entries: int = 10000
    cache_max_bytes: int = 64 * 1024 * 1024

    search_timeout_seconds: int = 15
    search_max_bytes: int = 2 * 1024 * 1024
    search_proxy_url: str = ""
    search_user_agent: str = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 Matrius/0.1"
    )
    fetch_max_bytes: int = 5 * 1024 * 1024

    auth_session_ttl_seconds: int = 604800
    initial_admin_username: str = ""
    initial_admin_password: str = ""
    preview_username: str = "admin_test"

    max_upload_bytes: int = 20 * 1024 * 1024
    storage_quota_bytes: int = 512 * 1024 * 1024
    fetch_max_chars: int = 50000

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
