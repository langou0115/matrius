from collections.abc import AsyncIterator
from pathlib import Path

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings

settings = get_settings()

_is_sqlite = settings.database_url.startswith("sqlite")
_connect_args = (
    {"timeout": settings.sqlite_busy_timeout_ms / 1000} if _is_sqlite else {}
)

_sqlite_file = _is_sqlite and ":memory:" not in settings.database_url
if _sqlite_file:
    # Small pools win for SQLite in this process model: every extra aiosqlite worker
    # thread competes for the GIL while sqlite3 hands it back once per fetched row, so
    # 5+ concurrent readers can be an order of magnitude slower than 2. Two connections
    # also leave one free while a slow upload/download holds the other.
    _pool_args = {
        "pool_size": 2 if settings.db_pool_size is None else settings.db_pool_size,
        "max_overflow": 0 if settings.db_max_overflow is None else settings.db_max_overflow,
    }
elif settings.db_pool_size is not None or settings.db_max_overflow is not None:
    _pool_args = {
        "pool_size": 5 if settings.db_pool_size is None else settings.db_pool_size,
        "max_overflow": 10 if settings.db_max_overflow is None else settings.db_max_overflow,
    }
else:
    _pool_args = {}

# pre_ping is a no-op waste for a local file (and an extra query per checkout);
# keep it for network databases where the connection can die.
engine = create_async_engine(
    settings.database_url,
    pool_pre_ping=not _is_sqlite,
    connect_args=_connect_args,
    **_pool_args,
)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

if _is_sqlite:

    @event.listens_for(engine.sync_engine, "connect")
    def _configure_sqlite(dbapi_connection, _record) -> None:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute(f"PRAGMA busy_timeout={settings.sqlite_busy_timeout_ms}")
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=NORMAL")
        finally:
            cursor.close()


def ensure_data_dir() -> Path:
    """Create the persistent directory layout. Safe to call repeatedly."""
    root = Path(settings.data_dir).expanduser().resolve()
    (root / "files").mkdir(parents=True, exist_ok=True)
    return root


async def get_db() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session


async def dispose_engine() -> None:
    await engine.dispose()
