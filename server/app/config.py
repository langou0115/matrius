import logging
import os
import threading

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)


def _env_files() -> tuple[str, ...]:
    """Environment files for this process.

    Development gets a second source so `npm run dev` can hot-read .env.local without
    restarting uvicorn. The entrypoint sets MATRIUS_DEV_ENV_FILE; production never does,
    and APP_ENV=production is a second guard. Real environment variables still win over
    both files, so the entrypoint's forced DATABASE_URL/DATA_DIR cannot be overridden.
    """
    files = [".env"]
    dev_file = os.environ.get("MATRIUS_DEV_ENV_FILE", "").strip()
    if dev_file and os.environ.get("APP_ENV", "development") == "development":
        files.append(dev_file)
    return tuple(files)


def _dev_env_stamp() -> tuple[int, int, int] | None:
    dev_file = os.environ.get("MATRIUS_DEV_ENV_FILE", "").strip()
    if not dev_file or os.environ.get("APP_ENV", "development") != "development":
        return None
    try:
        info = os.stat(dev_file)
    except OSError:
        return None
    return info.st_mtime_ns, info.st_size, info.st_ino


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

    # Queue pool sizing. Keep this a knob because the effective read ceiling depends
    # on the host: CPython's GIL plus sqlite3's per-row hand-off makes many in-process
    # SQLite readers slower than a small number on some kernels/VMs. Unset means
    # "SQLite: 2/0, other databases: 5/10"; set both to override.
    db_pool_size: int | None = None
    db_max_overflow: int | None = None

    # In-process cache and rate limiting. Exactly one uvicorn worker may run,
    # because this state is not shared between processes.
    cache_max_entries: int = 10000
    cache_max_bytes: int = 64 * 1024 * 1024

    # Total budget for one search, shared by DuckDuckGo and the Bing fallback.
    search_timeout_seconds: int = 8
    # A single ddgs attempt. Half of the total budget stays available for the Bing fallback.
    search_ddgs_timeout_seconds: int = 4
    search_max_attempts: int = 2
    search_fallback: bool = True
    search_breaker_failures: int = 3
    search_breaker_cooldown_seconds: int = 60
    search_max_bytes: int = 2 * 1024 * 1024
    # Shared by web search and page fetching. Leave empty to connect directly.
    # The env name has no separator between WEB and TOOL, so it needs an explicit alias.
    web_tool_proxy_url: str = Field(default="", validation_alias="WEBTOOL_PROXY_URL")
    search_user_agent: str = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 Matrius/0.1"
    )
    fetch_timeout_seconds: int = 45
    fetch_max_attempts: int = 2
    fetch_max_bytes: int = 5 * 1024 * 1024
    # Short-lived fetch cache: research agents often re-read the same source within one reply.
    fetch_cache_ttl_seconds: int = 600
    # Per-account in-flight cap for each web tool, on top of the global provider semaphore.
    tool_user_concurrency: int = 4

    # Browser sessions stay signed in until logout/revocation. Browsers cap persistent
    # cookies (Chrome at 400 days), so refresh the cookie with this Max-Age on login.
    auth_cookie_seconds: int = 400 * 24 * 60 * 60
    initial_admin_username: str = ""
    initial_admin_password: str = ""
    preview_username: str = "admin_test"

    max_upload_bytes: int = 20 * 1024 * 1024
    storage_quota_bytes: int = 512 * 1024 * 1024
    fetch_max_chars: int = 50000

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


_settings: Settings | None = None
_settings_stamp: tuple[int, int, int] | None = None
_settings_lock = threading.Lock()


def _load_settings() -> Settings:
    # Passing _env_file on every construction keeps the development file path dynamic
    # instead of freezing it when this module is imported.
    return Settings(_env_file=_env_files())


def get_settings() -> Settings:
    global _settings, _settings_stamp
    stamp = _dev_env_stamp()
    if _settings is not None and stamp == _settings_stamp:
        return _settings
    with _settings_lock:
        # Re-check under the lock: another request or worker thread may have reloaded.
        stamp = _dev_env_stamp()
        if _settings is not None and stamp == _settings_stamp:
            return _settings
        try:
            fresh = _load_settings()
        except Exception:  # noqa: BLE001 - a half-edited dev file must not kill the API
            if _settings is None:
                raise
            # Keep the last valid values until the next edit. Production still fails fast
            # at startup because there is no previous Settings instance.
            logger.warning("Invalid .env.local; keeping the previous settings", exc_info=True)
            _settings_stamp = stamp
            return _settings
        reloaded = _settings is not None
        _settings = fresh
        _settings_stamp = stamp
        if reloaded and stamp is not None:
            logger.info("Reloaded development settings after .env.local changed")
        return fresh
