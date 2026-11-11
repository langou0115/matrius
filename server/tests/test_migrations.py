"""Exercise the squashed baseline through real Alembic commands."""
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
EXPECTED_TABLES = {
    "alembic_version",
    "conversation_deletions",
    "conversations",
    "files",
    "instance",
    "memory_entries",
    "messages",
    "preferences",
    "profile_fields",
    "profiles",
    "token_usage_daily",
    "token_usage_estimate_daily",
    "usage_backfills",
}


def run_alembic(*args: str, env: dict[str, str]) -> None:
    result = subprocess.run([sys.executable, "-m", "alembic", *args], cwd=SERVER_DIR,
                            env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr


def environment(tmp_path):
    return {**os.environ, "DATA_DIR": str(tmp_path),
            "DATABASE_URL": f"sqlite+aiosqlite:///{tmp_path / 'matrius.db'}"}


def test_baseline_upgrade_and_check_on_empty_database(tmp_path):
    env = environment(tmp_path)
    run_alembic("upgrade", "head", env=env)
    run_alembic("check", env=env)
    with sqlite3.connect(tmp_path / "matrius.db") as db:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert tables == EXPECTED_TABLES
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        assert db.execute("SELECT version_num FROM alembic_version").fetchone() == ("0001_initial",)
    # A fresh install must not leave migration snapshots next to the database.
    assert list(tmp_path.glob("*.before-account-removal-*.db")) == []


def test_baseline_is_repeatable_and_downgrades_cleanly(tmp_path):
    env = environment(tmp_path)
    run_alembic("upgrade", "head", env=env)
    run_alembic("upgrade", "head", env=env)
    run_alembic("downgrade", "base", env=env)
    with sqlite3.connect(tmp_path / "matrius.db") as db:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert tables == {"alembic_version"}
    run_alembic("upgrade", "head", env=env)
