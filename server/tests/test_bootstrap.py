from app import bootstrap
from app.models import Instance


async def test_bootstrap_is_idempotent(session_factory, monkeypatch):
    monkeypatch.setattr(bootstrap, "SessionLocal", session_factory)
    await bootstrap.bootstrap()
    await bootstrap.bootstrap()
    async with session_factory() as db:
        assert await db.get(Instance, 1) is not None
