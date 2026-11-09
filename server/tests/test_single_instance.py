import importlib.util
import sqlite3
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app import bootstrap, storage
from app.auth.security import hash_password
from app.models import Instance, StoredFile, User
from app.storage_migration import migrate_files


async def test_database_allows_only_one_instance_binding(session_factory):
    async with session_factory() as db:
        owner = User(username="owner", password_hash=hash_password("secret"))
        db.add(owner)
        await db.flush()
        db.add(Instance(id=1, owner_id=owner.id))
        await db.commit()
        db.add(Instance(id=2, owner_id=owner.id))
        with pytest.raises(IntegrityError):
            await db.commit()


async def test_bootstrap_cannot_switch_an_existing_owner(session_factory, monkeypatch):
    async with session_factory() as db:
        owner = User(username="owner", password_hash=hash_password("secret"))
        db.add(owner)
        await db.flush()
        db.add(Instance(id=1, owner_id=owner.id))
        await db.commit()
    monkeypatch.setattr(bootstrap, "SessionLocal", session_factory)
    monkeypatch.setattr(bootstrap, "get_settings", lambda: SimpleNamespace(
        initial_admin_username="another", initial_admin_password="secret",
    ))
    with pytest.raises(RuntimeError, match="bound instance owner"):
        await bootstrap.bootstrap()


async def test_legacy_files_are_copied_and_migration_can_be_repeated(session_factory, tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "get_settings", lambda: SimpleNamespace(data_dir=str(tmp_path)))
    async with session_factory() as db:
        owner = User(username="legacy", password_hash="unused")
        db.add(owner)
        await db.flush()
        file_id = uuid.uuid4()
        old = f"users/{owner.id}/{file_id}/random.txt"
        storage.put_object(old, b"preserved", "text/plain")
        db.add(StoredFile(id=file_id, user_id=owner.id, filename="notes.txt", object_key=old,
                          content_type="text/plain", size=9, sha256="unused"))
        await db.commit()
        await migrate_files(db)
        await migrate_files(db)
        stored = (await db.execute(select(StoredFile))).scalar_one()
        assert stored.object_key == f"{file_id}/notes.txt"
        assert (tmp_path / "files" / str(file_id) / "notes.txt").read_bytes() == b"preserved"
        assert storage.get_object(old) == b"preserved"


def test_legacy_dev_database_copy_is_repeatable_and_does_not_overwrite(tmp_path):
    script = Path(__file__).resolve().parents[1] / "scripts/migrate-dev-database.py"
    spec = importlib.util.spec_from_file_location("migrate_dev_database", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with sqlite3.connect(tmp_path / "dev.db") as old:
        old.execute("CREATE TABLE sample (value TEXT)")
        old.execute("INSERT INTO sample VALUES ('preserved')")
    module.migrate(tmp_path)
    with sqlite3.connect(tmp_path / "matrius.db") as new:
        assert new.execute("SELECT value FROM sample").fetchone() == ("preserved",)
        new.execute("UPDATE sample SET value='newer'")
    module.migrate(tmp_path)
    with sqlite3.connect(tmp_path / "matrius.db") as new:
        assert new.execute("SELECT value FROM sample").fetchone() == ("newer",)
    assert (tmp_path / "dev.db").is_file()
