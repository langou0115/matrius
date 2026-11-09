"""Initialize the sole instance owner and normalize legacy file storage."""

import asyncio
import logging

from sqlalchemy import select, update

from app.auth.security import hash_password, verify_password
from app.config import get_settings
from app.db import SessionLocal, dispose_engine
from app.models import AuthSession, Instance, User
from app.storage_migration import migrate_files
from app.utils import utcnow


async def bootstrap() -> None:
    settings = get_settings()
    # Existing environment names remain valid for deployment compatibility.
    username = settings.initial_admin_username.strip()
    password = settings.initial_admin_password
    async with SessionLocal() as db:
        instance = await db.get(Instance, 1)
        if instance is None:
            users = list((await db.execute(select(User))).scalars())
            matches = [user for user in users if user.username.lower() == username.lower()]
            if len(users) > 1 and not matches:
                raise RuntimeError("Set INITIAL_ADMIN_USERNAME to the existing instance owner.")
            owner = matches[0] if matches else users[0] if users else None
            if owner is None:
                if not username or not password:
                    raise RuntimeError("INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD are required.")
                owner = User(username=username, password_hash=hash_password(password))
                db.add(owner)
                await db.flush()
            db.add(Instance(id=1, owner_id=owner.id))
            await db.commit()
        else:
            owner = await db.get(User, instance.owner_id)
        if owner is None:
            raise RuntimeError("Instance owner is missing.")
        if username and username.lower() != owner.username.lower():
            raise RuntimeError("INITIAL_ADMIN_USERNAME must match the bound instance owner.")
        if username and password and not verify_password(owner.password_hash, password):
            owner.password_hash = hash_password(password)
            owner.must_change_password = False
            await db.execute(update(AuthSession).values(revoked_at=utcnow()))
        await db.commit()
        await migrate_files(db)


async def _run() -> None:
    try:
        await bootstrap()
    finally:
        await dispose_engine()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(_run())


if __name__ == "__main__":
    main()
