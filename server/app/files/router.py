import asyncio
import hashlib
import mimetypes
import re
import uuid
from datetime import datetime
from pathlib import PurePath
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import case, func, not_, or_, select, tuple_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import AuthContext, read_rate_limit, write_rate_limit
from app.cache import enforce_rate_limit
from app.config import get_settings
from app.db import get_db
from app.errors import AppError, invalid, not_found
from app.files.parsing import TEXT_EXTENSIONS
from app.models import Conversation, StoredFile
from app.storage import delete_object, get_object, put_object
from app.utils import decode_cursor, encode_cursor, ensure_aware, to_ms, validate_client_id

router = APIRouter(prefix="/api/files", tags=["files"])

IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "gif"}
DOCUMENT_EXTENSIONS = {"pdf", "docx", "xlsx", "pptx"}
LEGACY_DOCUMENT_EXTENSIONS = {"doc", "xls", "ppt"}
ALLOWED_EXTENSIONS = TEXT_EXTENSIONS | IMAGE_EXTENSIONS | DOCUMENT_EXTENSIONS | LEGACY_DOCUMENT_EXTENSIONS
UPLOAD_SEMAPHORE = asyncio.Semaphore(2)
_SAFE_NAME_RE = re.compile(r"[^\w.\- ]+", re.UNICODE)
_SORT_KEYS = {"created", "name", "size"}


class FilePatch(BaseModel):
    filename: str = Field(min_length=1, max_length=255)


class BulkDeleteRequest(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=100)


def _conversation_conditions(value: str):
    """Match a conversation by either its server id or the id the client uses.

    Conversations are created with a client-generated (or server-assigned) id and a separate
    primary key, so the chat client only ever knows `client_id`. Accepting both keeps uploads
    from older conversations working while still writing the canonical server id.
    """
    raw = validate_client_id(value)
    conditions = [Conversation.client_id == raw]
    try:
        conditions.append(Conversation.id == uuid.UUID(raw))
    except ValueError:
        pass
    return conditions


async def _resolve_conversation_id(
    db: AsyncSession, user_id: uuid.UUID, value: str | None,
) -> uuid.UUID | None:
    if value is None:
        return None
    return (
        await db.execute(
            select(Conversation.id)
            .where(Conversation.user_id == user_id, or_(*_conversation_conditions(value)))
            .limit(1)
        )
    ).scalar_one_or_none()


def file_out(stored: StoredFile) -> dict[str, Any]:
    return {
        "id": str(stored.id),
        "clientId": stored.client_id,
        "conversationId": str(stored.conversation_id) if stored.conversation_id else None,
        "filename": stored.filename,
        "contentType": stored.content_type,
        "size": stored.size,
        "sha256": stored.sha256,
        "status": stored.status,
        "revision": stored.revision,
        "createdAt": to_ms(stored.created_at),
    }


def safe_filename(filename: str) -> str:
    base = PurePath(filename.replace("\\", "/")).name or "file"
    base = _SAFE_NAME_RE.sub("_", base).strip(" .")[:120]
    return base or "file"


def read_object_bytes(key: str) -> bytes:
    return get_object(key)


async def get_owned_file(db: AsyncSession, user_id: uuid.UUID, file_id: uuid.UUID) -> StoredFile:
    stored = (
        await db.execute(select(StoredFile).where(StoredFile.id == file_id, StoredFile.user_id == user_id))
    ).scalar_one_or_none()
    if stored is None:
        raise not_found("文件不存在。")
    return stored


async def load_file_bytes(stored: StoredFile) -> bytes:
    try:
        return await asyncio.to_thread(read_object_bytes, stored.object_key)
    except Exception as exc:  # noqa: BLE001
        raise AppError(502, "storage_error", "无法读取文件，请稍后重试。") from exc


@router.post("", status_code=201)
async def upload_file(
    file: UploadFile = File(...),
    conversationId: str | None = Form(default=None, max_length=128),
    clientId: str | None = Form(default=None),
    ctx: AuthContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    settings = get_settings()
    await enforce_rate_limit("upload", str(ctx.user.id), 20)
    client_id = validate_client_id(clientId)

    if client_id is not None:
        existing = (
            await db.execute(
                select(StoredFile).where(
                    StoredFile.user_id == ctx.user.id, StoredFile.client_id == client_id
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            return file_out(existing)

    filename = safe_filename(file.filename or "file")
    suffix = PurePath(filename).suffix.lower().lstrip(".")
    if suffix not in ALLOWED_EXTENSIONS:
        raise AppError(415, "unsupported_file_type", "不支持的文件类型。")

    resolved_conversation_id = await _resolve_conversation_id(db, ctx.user.id, conversationId)
    if conversationId is not None and resolved_conversation_id is None:
        raise not_found("对话不存在。")

    async with UPLOAD_SEMAPHORE:
        data = await file.read(settings.max_upload_bytes + 1)
        if len(data) > settings.max_upload_bytes:
            raise AppError(413, "file_too_large", "单个文件不能超过 20 MiB。")
        if not data:
            raise invalid("文件为空。")

        used = (
            await db.execute(
                select(func.coalesce(func.sum(StoredFile.size), 0)).where(
                    StoredFile.user_id == ctx.user.id
                )
            )
        ).scalar_one()
        if used + len(data) > settings.storage_quota_bytes:
            raise AppError(413, "quota_exceeded", "存储空间已用尽。")

        # Everything below is storage I/O and needs no DB state; free the connection
        # so a slow upload does not pin one of the two SQLite pool slots.
        await db.close()
        stored_id = uuid.uuid4()
        content_type = file.content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
        object_key = f"users/{ctx.user.id}/{stored_id}/{filename}"
        digest = hashlib.sha256(data).hexdigest()

        try:
            await asyncio.to_thread(put_object, object_key, data, content_type)
        except Exception as exc:  # noqa: BLE001
            raise AppError(502, "storage_error", "文件上传失败，请稍后重试。") from exc

    stored = StoredFile(
        id=stored_id,
        user_id=ctx.user.id,
        client_id=client_id,
        conversation_id=resolved_conversation_id,
        filename=filename,
        object_key=object_key,
        content_type=content_type,
        size=len(data),
        sha256=digest,
    )
    db.add(stored)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        await asyncio.to_thread(delete_object, object_key)
        raise AppError(409, "conflict", "文件已存在，请刷新后重试。") from None
    except Exception:
        await db.rollback()
        await asyncio.to_thread(delete_object, object_key)
        raise
    return file_out(stored)


def _suffix_filter(extensions: set[str]):
    column = func.lower(StoredFile.filename)
    return or_(*(column.like(f"%.{suffix}") for suffix in sorted(extensions)))


def _kind_filter(kind: str):
    if kind == "image":
        return _suffix_filter(IMAGE_EXTENSIONS)
    if kind == "document":
        return _suffix_filter(DOCUMENT_EXTENSIONS | LEGACY_DOCUMENT_EXTENSIONS)
    if kind == "text":
        return _suffix_filter(TEXT_EXTENSIONS)
    if kind == "file":
        # Everything that is not an image: documents, text and legacy Office.
        return not_(_suffix_filter(IMAGE_EXTENSIONS))
    return None


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _sort_column(sort: str):
    return {
        "created": StoredFile.created_at,
        "name": StoredFile.filename,
        "size": StoredFile.size,
    }[sort]


def _sort_value(sort: str, item: StoredFile) -> str:
    if sort == "created":
        return ensure_aware(item.created_at).isoformat()
    if sort == "name":
        return item.filename
    return str(item.size)


def _parse_file_cursor(cursor: str, sort: str):
    raw_value, raw_id = decode_cursor(cursor, 2)
    try:
        item_id = uuid.UUID(raw_id)
        if sort == "created":
            value: Any = ensure_aware(datetime.fromisoformat(raw_value))
        elif sort == "size":
            value = int(raw_value)
        else:
            value = raw_value
    except (ValueError, TypeError) as exc:
        raise invalid("分页游标无效。") from exc
    return value, item_id


@router.get("")
async def list_files(
    query: str | None = Query(default=None, max_length=200),
    kind: str = Query(default="all"),
    sort: str = Query(default="created"),
    order: str = Query(default="desc"),
    conversationId: str | None = Query(default=None, max_length=128),
    cursor: str | None = None,
    limit: int = Query(default=100, ge=1, le=200),
    ctx: AuthContext = Depends(read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    if kind not in {"all", "image", "file", "document", "text"}:
        raise invalid("筛选条件不合法。")
    if sort not in _SORT_KEYS or order not in {"asc", "desc"}:
        raise invalid("排序条件不合法。")

    stmt = select(StoredFile).where(StoredFile.user_id == ctx.user.id)
    if conversationId is not None:
        scoped_id = await _resolve_conversation_id(db, ctx.user.id, conversationId)
        # An unknown conversation has no files; keeping the filter empty avoids leaking
        # whether the id exists for another account.
        if scoped_id is None:
            return {"items": [], "nextCursor": None}
        stmt = stmt.where(StoredFile.conversation_id == scoped_id)
    term = (query or "").strip()
    if term:
        stmt = stmt.where(StoredFile.filename.ilike(f"%{_escape_like(term)}%", escape="\\"))
    kind_filter = _kind_filter(kind)
    if kind_filter is not None:
        stmt = stmt.where(kind_filter)

    column = _sort_column(sort)
    descending = order == "desc"
    if cursor:
        value, item_id = _parse_file_cursor(cursor, sort)
        if descending:
            stmt = stmt.where(tuple_(column, StoredFile.id) < tuple_(value, item_id))
        else:
            stmt = stmt.where(tuple_(column, StoredFile.id) > tuple_(value, item_id))
    direction = column.desc() if descending else column.asc()
    id_direction = StoredFile.id.desc() if descending else StoredFile.id.asc()
    stmt = stmt.order_by(direction, id_direction).limit(limit + 1)

    rows = list((await db.execute(stmt)).scalars().all())
    has_more = len(rows) > limit
    rows = rows[:limit]
    return {
        "items": [file_out(item) for item in rows],
        "nextCursor": (
            encode_cursor(_sort_value(sort, rows[-1]), str(rows[-1].id))
            if has_more and rows
            else None
        ),
    }


@router.get("/usage")
async def file_usage(
    ctx: AuthContext = Depends(read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    settings = get_settings()
    images = _suffix_filter(IMAGE_EXTENSIONS)
    used, total, image_bytes, image_count = (
        await db.execute(
            select(
                func.coalesce(func.sum(StoredFile.size), 0),
                func.count(StoredFile.id),
                func.coalesce(func.sum(case((images, StoredFile.size), else_=0)), 0),
                func.coalesce(func.sum(case((images, 1), else_=0)), 0),
            ).where(StoredFile.user_id == ctx.user.id)
        )
    ).one()
    # "files" is everything that is not an image, so the two categories never overlap.
    return {
        "used": used,
        "quota": settings.storage_quota_bytes,
        "files": {"bytes": used - image_bytes, "count": total - image_count},
        "images": {"bytes": image_bytes, "count": image_count},
    }


@router.post("/bulk-delete")
async def bulk_delete_files(
    payload: BulkDeleteRequest,
    ctx: AuthContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    ids = list(dict.fromkeys(payload.ids))
    files = list(
        (
            await db.execute(
                select(StoredFile).where(
                    StoredFile.id.in_(ids), StoredFile.user_id == ctx.user.id
                )
            )
        )
        .scalars()
        .all()
    )
    object_keys = [item.object_key for item in files]
    for item in files:
        await db.delete(item)
    # Commit the rows first: an orphaned object is recoverable, a row pointing at a
    # deleted object is not.
    await db.commit()
    for key in object_keys:
        try:
            await asyncio.to_thread(delete_object, key)
        except Exception:  # noqa: BLE001 - best effort cleanup
            pass
    return {"deleted": len(files)}


@router.patch("/{file_id}")
async def rename_file(
    file_id: uuid.UUID,
    payload: FilePatch,
    ctx: AuthContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    stored = await get_owned_file(db, ctx.user.id, file_id)
    filename = safe_filename(payload.filename)
    if PurePath(filename).suffix.lower() != PurePath(stored.filename).suffix.lower():
        raise invalid("不能修改文件扩展名。")
    if filename != stored.filename:
        stored.filename = filename
        stored.revision += 1
        await db.commit()
    return file_out(stored)


@router.get("/{file_id}")
async def get_file(
    file_id: uuid.UUID,
    ctx: AuthContext = Depends(read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return file_out(await get_owned_file(db, ctx.user.id, file_id))


@router.get("/{file_id}/content")
async def download_file(
    file_id: uuid.UUID,
    ctx: AuthContext = Depends(read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> Response:
    stored = await get_owned_file(db, ctx.user.id, file_id)
    # Read from disk after the row is loaded; the connection is not needed for the bytes.
    await db.close()
    data = await load_file_bytes(stored)
    disposition = "inline" if stored.content_type.startswith("image/") else "attachment"
    headers = {
        "Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(stored.filename)}",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
    }
    return Response(content=data, media_type=stored.content_type, headers=headers)


@router.delete("/{file_id}")
async def delete_file(
    file_id: uuid.UUID,
    ctx: AuthContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    stored = await get_owned_file(db, ctx.user.id, file_id)
    await db.close()
    await asyncio.to_thread(delete_object, stored.object_key)
    await db.delete(stored)
    await db.commit()
    return {"ok": True}
