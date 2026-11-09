from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app import bootstrap as bootstrap_module
from app.auth.security import hash_password, verify_password
from app.models import User


def configure(monkeypatch, *, username: str, password: str, app_env: str = "development") -> None:
    monkeypatch.setattr(
        bootstrap_module,
        "get_settings",
        lambda: SimpleNamespace(
            app_env=app_env,
            initial_admin_username=username,
            initial_admin_password=password,
        ),
    )


@pytest.fixture(autouse=True)
def use_test_database(monkeypatch, session_factory):
    monkeypatch.setattr(bootstrap_module, "SessionLocal", session_factory)


async def _admin(session_factory) -> User:
    async with session_factory() as session:
        return (await session.execute(select(User).where(User.username == "admin"))).scalar_one()


async def test_bootstrap_creates_the_initial_admin(session_factory, monkeypatch):
    configure(monkeypatch, username="admin", password="first-secret")

    await bootstrap_module.bootstrap()

    user = await _admin(session_factory)
    assert user.must_change_password is False
    assert verify_password(user.password_hash, "first-secret")


async def test_bootstrap_syncs_an_existing_admin_password(session_factory, monkeypatch):
    async with session_factory() as session:
        session.add(User(username="admin", password_hash=hash_password("old-secret")))
        await session.commit()
    configure(monkeypatch, username="admin", password="new-secret")

    await bootstrap_module.bootstrap()

    user = await _admin(session_factory)
    assert verify_password(user.password_hash, "new-secret")
    assert not verify_password(user.password_hash, "old-secret")


async def test_production_bootstrap_applies_the_latest_password(session_factory, monkeypatch):
    async with session_factory() as session:
        session.add(User(username="admin", password_hash=hash_password("old-secret"),
                         must_change_password=True))
        await session.commit()
    configure(monkeypatch, username="admin", password="new-secret", app_env="production")

    await bootstrap_module.bootstrap()

    user = await _admin(session_factory)
    assert verify_password(user.password_hash, "new-secret")
    assert not verify_password(user.password_hash, "old-secret")
    assert user.must_change_password is False


async def test_bootstrap_leaves_the_password_when_credentials_are_empty(session_factory, monkeypatch):
    async with session_factory() as session:
        session.add(User(username="admin", password_hash=hash_password("old-secret")))
        await session.commit()
    configure(monkeypatch, username="", password="", app_env="production")

    await bootstrap_module.bootstrap()

    user = await _admin(session_factory)
    assert verify_password(user.password_hash, "old-secret")
