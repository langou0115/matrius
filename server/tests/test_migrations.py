"""Run Alembic against a throwaway SQLite file, exactly as the API entrypoint does."""

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]


def run_alembic(*args: str, env: dict[str, str]) -> str:
    result = subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=SERVER_DIR,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, f"alembic {' '.join(args)} failed:\n{result.stdout}\n{result.stderr}"
    return result.stdout


def test_upgrade_and_check_pass_on_a_fresh_sqlite_database(tmp_path):
    database = tmp_path / "matrius.db"
    env = {
        **os.environ,
        "DATA_DIR": str(tmp_path),
        "DATABASE_URL": f"sqlite+aiosqlite:///{database}",
    }

    run_alembic("upgrade", "head", env=env)
    run_alembic("check", env=env)

    assert database.exists()
    with sqlite3.connect(database) as connection:
        tables = {
            row[0]
            for row in connection.execute("select name from sqlite_master where type = 'table'")
        }
        revision = connection.execute("select version_num from alembic_version").fetchone()[0]
    assert {
        "users",
        "auth_sessions",
        "conversations",
        "conversation_deletions",
        "messages",
        "files",
        "user_profiles",
        "user_preferences",
        "memory_entries",
        "alembic_version",
    } <= tables

    head = run_alembic("heads", env=env).split()[0]
    assert revision == head


def test_permanent_sessions_upgrade_handles_existing_rows(tmp_path):
    """0004 relaxes expires_at for sessions that were created with a value.

    Applying the update before dropping NOT NULL fails on any non-empty database,
    which a fresh-database check cannot catch.
    """
    database = tmp_path / "matrius.db"
    env = {
        **os.environ,
        "DATA_DIR": str(tmp_path),
        "DATABASE_URL": f"sqlite+aiosqlite:///{database}",
    }

    run_alembic("upgrade", "0003_message_steering", env=env)
    with sqlite3.connect(database) as connection:
        connection.execute(
            "insert into users (id, username, password_hash) values (?, ?, ?)",
            ("0" * 31 + "1", "alice", "hash"),
        )
        connection.execute(
            "insert into auth_sessions (id, user_id, token_hash, scope, expires_at) "
            "values (?, ?, ?, 'user', datetime('now', '+7 days'))",
            ("0" * 31 + "2", "0" * 31 + "1", "token-hash"),
        )
        connection.commit()

    run_alembic("upgrade", "head", env=env)
    run_alembic("check", env=env)

    with sqlite3.connect(database) as connection:
        rows = connection.execute("select expires_at from auth_sessions").fetchall()
        columns = {
            row[1]: row[3]
            for row in connection.execute("pragma table_info(auth_sessions)")
        }
    assert rows == [(None,)]
    assert columns["expires_at"] == 0, "expires_at must allow NULL"
