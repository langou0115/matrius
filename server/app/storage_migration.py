"""Restartable conversion to DATA_DIR/files/<fileId>/<filename>."""

import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.router import safe_filename
from app.models import StoredFile
from app.storage import get_object, put_object


async def migrate_files(db: AsyncSession) -> None:
    files = list((await db.execute(select(StoredFile))).scalars())
    for stored in files:
        target = f"{stored.id}/{safe_filename(stored.filename)}"
        if stored.object_key == target:
            continue
        # Copy first, commit the pointer second. Old bytes remain available if migration
        # stops midway; rerunning is safe. Historical instance data is not discarded.
        data = await asyncio.to_thread(get_object, stored.object_key)
        await asyncio.to_thread(put_object, target, data, stored.content_type)
        stored.object_key = target
        await db.commit()
