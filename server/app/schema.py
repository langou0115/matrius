"""Verify that the database schema matches the migrations baked into this image.

Comparing the recorded revision with the migration head catches deployments
where new application code would otherwise run against an older schema.
"""

from functools import lru_cache
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text

from app.db import engine

ALEMBIC_INI = Path(__file__).resolve().parent.parent / "alembic.ini"


@lru_cache(maxsize=1)
def migration_head() -> str | None:
    """Return the single head revision, or None when the graph is ambiguous."""
    if not ALEMBIC_INI.exists():
        return None
    config = Config(str(ALEMBIC_INI))
    config.set_main_option("script_location", str(ALEMBIC_INI.parent / "alembic"))
    heads = ScriptDirectory.from_config(config).get_heads()
    return heads[0] if len(heads) == 1 else None


async def database_revision() -> str | None:
    async with engine.connect() as connection:
        result = await connection.execute(text("SELECT version_num FROM alembic_version"))
        return result.scalar_one_or_none()


async def schema_status() -> tuple[bool, str]:
    expected = migration_head()
    if expected is None:
        return False, "no single migration head in this image"
    current = await database_revision()
    if current != expected:
        return False, f"database at {current or 'unversioned'}, application expects {expected}"
    return True, "ok"
