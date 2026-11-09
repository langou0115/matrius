"""Shared helpers for upload, drafts and Library operations."""

import asyncio
import uuid
from typing import Any
from weakref import WeakValueDictionary

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.errors import AppError
from app.models import StoredFile

_file_locks: WeakValueDictionary[uuid.UUID, asyncio.Lock] = WeakValueDictionary()


def file_lock(file_id: uuid.UUID) -> asyncio.Lock:
    """Serialize mutations of the same named object within the single API worker."""
    lock = _file_locks.get(file_id)
    if lock is None:
        lock = asyncio.Lock()
        _file_locks[file_id] = lock
    return lock


def file_summary(stored: StoredFile) -> dict[str, Any]:
    """Metadata embedded in messages. No object key or storage details leak."""

    return {
        "id": str(stored.id),
        "filename": stored.filename,
        "contentType": stored.content_type,
        "size": stored.size,
        "revision": stored.revision,
    }


async def storage_used(db: AsyncSession, user_id: uuid.UUID) -> int:
    return (
        await db.execute(
            select(func.coalesce(func.sum(StoredFile.size), 0)).where(StoredFile.user_id == user_id)
        )
    ).scalar_one()


async def ensure_quota(db: AsyncSession, user_id: uuid.UUID, new_size: int, *, replacing: int = 0) -> None:
    settings = get_settings()
    used = await storage_used(db, user_id)
    if used - replacing + new_size > settings.storage_quota_bytes:
        raise AppError(413, "quota_exceeded", "存储空间已用尽。")
