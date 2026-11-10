"""Initialize the singleton instance row."""
import asyncio
import logging

from app.db import SessionLocal, dispose_engine
from app.models import Instance


async def bootstrap() -> None:
    async with SessionLocal() as db:
        if await db.get(Instance, 1) is None:
            db.add(Instance(id=1))
            await db.commit()


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
