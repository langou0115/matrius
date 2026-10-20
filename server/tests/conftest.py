import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.admin import router as admin_router_module
from app.auth import dependencies as auth_dependencies
from app.auth import router as auth_router_module
from app.auth.security import hash_password
from app.db import get_db
from app.files import router as files_router_module
from app.main import app
from app.models import Base, User
from app.tools import files as tools_files_module
from app.tools import router as tools_router_module


async def _noop(*args, **kwargs):
    return None


@pytest.fixture(autouse=True)
def disable_redis(monkeypatch):
    for module in (
        admin_router_module,
        auth_router_module,
        auth_dependencies,
        files_router_module,
        tools_router_module,
    ):
        monkeypatch.setattr(module, "enforce_rate_limit", _noop, raising=False)
    for name in ("assert_login_not_locked", "record_login_failure", "clear_login_failures"):
        monkeypatch.setattr(auth_router_module, name, _noop)

    async def fake_cache_get(_key):
        return None

    monkeypatch.setattr(tools_files_module, "cache_get", fake_cache_get)
    monkeypatch.setattr(tools_files_module, "cache_set", _noop)


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
async def create_user(client, session_factory):
    async def factory(
        username: str = "alice",
        password: str = "password123",
        *,
        is_admin: bool = False,
        must_change_password: bool = False,
    ):
        async with session_factory() as session:
            user = User(
                username=username,
                password_hash=hash_password(password),
                is_admin=is_admin,
                must_change_password=must_change_password,
            )
            session.add(user)
            await session.commit()
            user_id = user.id

        path = "/api/admin/auth/login" if is_admin else "/api/auth/login"
        response = await client.post(path, json={"username": username, "password": password})
        assert response.status_code == 200, response.text
        token = response.json()["token"]
        return user_id, {"Authorization": f"Bearer {token}"}

    return factory
