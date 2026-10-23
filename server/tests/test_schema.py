from app import schema


async def test_schema_status_accepts_a_database_at_the_image_head(monkeypatch):
    monkeypatch.setattr(schema, "migration_head", lambda: "0001")

    async def revision() -> str:
        return "0001"

    monkeypatch.setattr(schema, "database_revision", revision)
    assert await schema.schema_status() == (True, "ok")


async def test_schema_status_rejects_old_or_unversioned_databases(monkeypatch):
    monkeypatch.setattr(schema, "migration_head", lambda: "0002")

    async def old() -> str:
        return "0001"

    monkeypatch.setattr(schema, "database_revision", old)
    ok, detail = await schema.schema_status()
    assert not ok
    assert "0001" in detail and "0002" in detail

    async def unversioned() -> None:
        return None

    monkeypatch.setattr(schema, "database_revision", unversioned)
    ok, detail = await schema.schema_status()
    assert not ok
    assert "unversioned" in detail
