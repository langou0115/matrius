"""Temporary documents produced by ``create``/``edit`` before ``save``.

Metadata lives in this process (single uvicorn worker); bytes live under
``DATA_DIR/drafts`` so a few 20 MiB drafts never sit in memory. A restart drops
the metadata, so startup also clears the leftover directories — consistent with
the "draft is temporary" contract.
"""

import asyncio
import os
import shutil
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from app.config import get_settings
from app.errors import AppError

DRAFT_PREFIX = "draft:"


def drafts_root() -> Path:
    return Path(get_settings().data_dir).expanduser().resolve() / "drafts"


@dataclass
class Draft:
    id: str
    user_id: uuid.UUID
    conversation_id: uuid.UUID | None
    filename: str
    content_type: str
    path: Path
    size: int
    base_file_id: uuid.UUID | None = None
    base_revision: int | None = None
    converted_from_legacy: bool = False
    # Wall clock for display; ``updated_at`` is monotonic for TTL comparisons.
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.monotonic)

    def summary(self) -> dict[str, object]:
        return {
            "id": self.id,
            "filename": self.filename,
            "contentType": self.content_type,
            "size": self.size,
            "conversationId": str(self.conversation_id) if self.conversation_id else None,
            "createdAt": int(self.created_at * 1000),
        }


class DraftStore:
    def __init__(self) -> None:
        self._drafts: dict[str, Draft] = {}
        self._lock = asyncio.Lock()

    def _path(self, draft_id: str) -> Path:
        # ``draft:<uuid>`` is the API handle; ``:`` is illegal in Windows paths.
        return drafts_root() / draft_id.removeprefix(DRAFT_PREFIX)

    async def reset_on_startup(self) -> None:
        root = drafts_root()
        if root.exists():
            await asyncio.to_thread(shutil.rmtree, root, True)

    async def put(
        self,
        *,
        user_id: uuid.UUID,
        conversation_id: uuid.UUID | None,
        filename: str,
        content_type: str,
        data: bytes,
        base_file_id: uuid.UUID | None = None,
        base_revision: int | None = None,
        converted_from_legacy: bool = False,
        draft_id: str | None = None,
    ) -> Draft:
        settings = get_settings()
        if len(data) > settings.max_upload_bytes:
            raise AppError(413, "file_too_large", "生成的文档不能超过 20 MiB。")
        if not data:
            raise AppError(422, "invalid_document_operation", "生成的文档为空。")

        async with self._lock:
            await self._sweep_locked()
            if draft_id is None:
                draft_id = f"{DRAFT_PREFIX}{uuid.uuid4()}"
            elif draft_id not in self._drafts:
                raise AppError(404, "draft_not_found", "草稿不存在或已过期。")
            else:
                existing = self._drafts[draft_id]
                if existing.user_id != user_id:
                    raise AppError(404, "draft_not_found", "草稿不存在或已过期。")

            others = [
                item for key, item in self._drafts.items()
                if key != draft_id and item.user_id == user_id
            ]
            if len(others) >= settings.document_draft_max_per_user:
                raise AppError(429, "draft_limit_exceeded", "草稿数量已达上限，请先保存或删除草稿。")
            used = sum(item.size for item in others)
            if used + len(data) > settings.document_draft_user_bytes:
                raise AppError(429, "draft_limit_exceeded", "草稿占用空间已达上限，请先保存。")

            target = self._path(draft_id) / "document"
            await asyncio.to_thread(_write_atomic, target, data)
            now = time.monotonic()
            previous = self._drafts.get(draft_id)
            draft = Draft(
                id=draft_id,
                user_id=user_id,
                conversation_id=conversation_id,
                filename=filename,
                content_type=content_type,
                path=target,
                size=len(data),
                base_file_id=base_file_id,
                base_revision=base_revision,
                converted_from_legacy=converted_from_legacy,
                created_at=previous.created_at if previous else time.time(),
                updated_at=now,
            )
            self._drafts[draft_id] = draft
            return draft

    async def get(self, user_id: uuid.UUID, draft_id: str) -> Draft:
        async with self._lock:
            await self._sweep_locked()
            draft = self._drafts.get(draft_id)
            if draft is None or draft.user_id != user_id:
                raise AppError(404, "draft_not_found", "草稿不存在或已过期。")
            draft.updated_at = time.monotonic()
            return draft

    async def read(self, draft: Draft) -> bytes:
        try:
            return await asyncio.to_thread(draft.path.read_bytes)
        except FileNotFoundError as exc:
            await self.delete(draft.user_id, draft.id)
            raise AppError(404, "draft_not_found", "草稿不存在或已过期。") from exc

    async def delete(self, user_id: uuid.UUID, draft_id: str) -> None:
        async with self._lock:
            draft = self._drafts.get(draft_id)
            if draft is None or draft.user_id != user_id:
                return
            self._drafts.pop(draft_id, None)
        await asyncio.to_thread(shutil.rmtree, draft.path.parent, True)

    async def list_for_user(self, user_id: uuid.UUID, conversation_id: uuid.UUID | None = None) -> list[Draft]:
        async with self._lock:
            await self._sweep_locked()
            items = [item for item in self._drafts.values() if item.user_id == user_id]
        if conversation_id is not None:
            items = [item for item in items if item.conversation_id == conversation_id]
        return sorted(items, key=lambda item: item.updated_at, reverse=True)

    async def _sweep_locked(self) -> None:
        now = time.monotonic()
        ttl = get_settings().document_draft_ttl_seconds
        expired = [key for key, item in self._drafts.items() if now - item.updated_at > ttl]
        for key in expired:
            draft = self._drafts.pop(key)
            await asyncio.to_thread(shutil.rmtree, draft.path.parent, True)


def _write_atomic(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".draft-", dir=target.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


drafts = DraftStore()
