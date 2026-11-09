import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.cache import reset_cache
from app.db import get_db
from app.files import router as files_router_module
from app.main import app
from app.models import Base, Instance
from app.tools import files as tools_files_module
from app.tools import router as tools_router_module


async def _noop(*args, **kwargs):
    return None


@pytest.fixture(autouse=True)
def disable_limits(monkeypatch):
    reset_cache()
    for module in (
        files_router_module,
        tools_router_module,
    ):
        monkeypatch.setattr(module, "enforce_rate_limit", _noop, raising=False)
    async def fake_cache_get(_key):
        return None

    monkeypatch.setattr(tools_files_module, "cache_get", fake_cache_get)
    monkeypatch.setattr(tools_files_module, "cache_set", _noop)
    yield
    reset_cache()


@pytest.fixture
async def engine():
    test_engine = create_async_engine("sqlite+aiosqlite://", poolclass=StaticPool)

    @event.listens_for(test_engine.sync_engine, "connect")
    def _enable_foreign_keys(dbapi_connection, _record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with test_engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield test_engine
    await test_engine.dispose()


@pytest.fixture
async def session_factory(engine):
    return async_sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
async def client(session_factory):
    async def override_get_db():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http_client:
        yield http_client
    app.dependency_overrides.clear()


@pytest.fixture
async def create_instance(client, session_factory):
    async def factory():
        async with session_factory() as db:
            if await db.get(Instance, 1) is None:
                db.add(Instance(id=1))
                await db.commit()
        return 1, {}
    return factory
