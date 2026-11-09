"""Exercise fresh and populated databases through real Alembic commands."""
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]


def run_alembic(*args: str, env: dict[str, str]) -> None:
    result = subprocess.run([sys.executable, "-m", "alembic", *args], cwd=SERVER_DIR,
                            env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr


def environment(tmp_path):
    return {**os.environ, "DATA_DIR": str(tmp_path),
            "DATABASE_URL": f"sqlite+aiosqlite:///{tmp_path / 'test.db'}"}


def test_upgrade_and_check_on_empty_database(tmp_path):
    env = environment(tmp_path)
    run_alembic("upgrade", "head", env=env)
    run_alembic("check", env=env)
    with sqlite3.connect(tmp_path / "test.db") as db:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert not tables.intersection({"users", "auth_sessions", "user_profiles", "user_preferences"})
        assert {"instance", "preferences", "profiles", "profile_fields"} <= tables
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_account_removal_preserves_business_data(tmp_path):
    env = environment(tmp_path)
    run_alembic("upgrade", "0010_single_user_instance", env=env)
    with sqlite3.connect(tmp_path / "test.db") as db:
        db.execute("INSERT INTO users (id, username, password_hash) VALUES (?, 'legacy', 'hash')", ("1" * 32,))
        db.execute("INSERT INTO instance (id, owner_id) VALUES (1, ?)", ("1" * 32,))
        db.execute("INSERT INTO conversations (id, user_id, title) VALUES (?, ?, 'preserved')",
                   ("2" * 32, "1" * 32))
        db.commit()
    run_alembic("upgrade", "head", env=env)
    run_alembic("check", env=env)
    with sqlite3.connect(tmp_path / "test.db") as db:
        assert db.execute("SELECT instance_id, title FROM conversations").fetchone() == (1, "preserved")
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_account_removal_resolves_multiple_legacy_settings_and_keeps_backup(tmp_path):
    env = environment(tmp_path)
    run_alembic("upgrade", "0010_single_user_instance", env=env)
    owner, other = "1" * 32, "2" * 32
    with sqlite3.connect(tmp_path / "test.db") as db:
        for identity, name in ((owner, "owner"), (other, "old")):
            db.execute("INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'hash')", (identity, name))
        db.execute("INSERT INTO instance (id, owner_id) VALUES (1, ?)", (owner,))
        for index, identity in enumerate((owner, other)):
            db.execute("INSERT INTO user_preferences (id, user_id, theme_id) VALUES (?, ?, ?)",
                       (str(index + 3) * 32, identity, f"theme-{index}"))
            db.execute("INSERT INTO user_profiles (id, user_id, about_name) VALUES (?, ?, ?)",
                       (str(index + 5) * 32, identity, f"name-{index}"))
            db.execute("INSERT INTO usage_backfills (user_id) VALUES (?)", (identity,))
            db.execute("INSERT INTO token_usage_daily (id, user_id, day, input_tokens) VALUES (?, ?, '2026-11-09', ?)",
                       (str(index + 7) * 32, identity, 10 + index))
            db.execute("INSERT INTO conversations (id, user_id, client_id, title) VALUES (?, ?, 'same-key', 'keep')",
                       (f"{index + 9:032x}", identity))
        db.commit()
    run_alembic("upgrade", "head", env=env)
    run_alembic("check", env=env)
    with sqlite3.connect(tmp_path / "test.db") as db:
        assert db.execute("SELECT theme_id FROM preferences").fetchall() == [("theme-0",)]
        assert db.execute("SELECT about_name FROM profiles").fetchall() == [("name-0",)]
        assert db.execute("SELECT COUNT(*) FROM conversations").fetchone()[0] == 2
        assert db.execute("SELECT input_tokens FROM token_usage_daily").fetchone()[0] == 21
        assert db.execute("SELECT COUNT(*) FROM usage_backfills").fetchone()[0] == 1
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    backups = list(tmp_path.glob("test.before-account-removal-*.db"))
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as db:
        assert db.execute("SELECT COUNT(*) FROM user_preferences").fetchone()[0] == 2
