"""Create the first administrator. Safe to run on every deploy."""

import asyncio
import logging

from sqlalchemy import func, select

from app.auth.security import hash_password
from app.config import get_settings
from app.db import SessionLocal, dispose_engine
from app.models import User

logger = logging.getLogger(__name__)


async def bootstrap() -> None:
    settings = get_settings()
    async with SessionLocal() as db:
        user_count = (await db.execute(select(func.count(User.id)))).scalar_one()
        if user_count:
            logger.info("Users already exist, skipping bootstrap")
            return

        username = settings.initial_admin_username.strip()
        password = settings.initial_admin_password
        if not username or not password:
            message = "INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD are required to bootstrap"
            if settings.app_env == "production":
                logger.error(message)
                raise SystemExit(1)
            logger.warning("%s; no administrator created", message)
            return
        db.add(
            User(
                username=username,
                password_hash=hash_password(password),
                is_admin=True,
                must_change_password=False,
            )
        )
        await db.commit()
        logger.info("Created initial administrator %s", username)


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
