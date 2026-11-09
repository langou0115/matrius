"""Shared helpers for upload, drafts and Library operations."""

import asyncio
import uuid
from typing import Any
from weakref import WeakValueDictionary

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


async def ensure_disk_space(new_size: int) -> None:
    from app.resources import disk_usage

    if new_size > (await asyncio.to_thread(disk_usage))["free"]:
        raise AppError(413, "disk_full", "服务器磁盘空间不足。")
