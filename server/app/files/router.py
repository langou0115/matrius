import asyncio
import hashlib
import mimetypes
import re
import uuid
from pathlib import PurePath
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import Response
from sqlalchemy import func, select
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
from app.utils import to_ms, validate_client_id

router = APIRouter(prefix="/api/files", tags=["files"])

IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "gif"}
DOCUMENT_EXTENSIONS = {"pdf", "docx", "xlsx", "pptx"}
ALLOWED_EXTENSIONS = TEXT_EXTENSIONS | IMAGE_EXTENSIONS | DOCUMENT_EXTENSIONS
UPLOAD_SEMAPHORE = asyncio.Semaphore(2)
_SAFE_NAME_RE = re.compile(r"[^\w.\- ]+", re.UNICODE)


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
    conversationId: uuid.UUID | None = Form(default=None),
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

    if conversationId is not None:
        owned = (
            await db.execute(
                select(Conversation.id).where(
                    Conversation.id == conversationId, Conversation.user_id == ctx.user.id
                )
            )
        ).scalar_one_or_none()
        if owned is None:
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
        conversation_id=conversationId,
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


@router.get("")
async def list_files(
    conversationId: uuid.UUID | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=200),
    ctx: AuthContext = Depends(read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    stmt = select(StoredFile).where(StoredFile.user_id == ctx.user.id)
    if conversationId is not None:
        stmt = stmt.where(StoredFile.conversation_id == conversationId)
    stmt = stmt.order_by(StoredFile.created_at.desc()).limit(limit)
    files = (await db.execute(stmt)).scalars().all()
    return {"items": [file_out(item) for item in files]}


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
    await asyncio.to_thread(delete_object, stored.object_key)
    await db.delete(stored)
    await db.commit()
    return {"ok": True}
