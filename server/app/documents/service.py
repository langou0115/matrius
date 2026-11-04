"""Dispatch for the unified ``file`` tool.

The router owns auth/rate limits/concurrency; this module owns document
semantics. Engine work happens after the SQLite connection is released.
"""

import asyncio
import hashlib
import uuid
from collections.abc import Coroutine
from dataclasses import dataclass
from pathlib import PurePath
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.documents import drafts as draft_store
from app.documents.binaries import resolve_officecli
from app.documents.drafts import Draft
from app.documents.libreoffice import LEGACY_FORMATS, convert_legacy_office
from app.documents.officecli import office_create, office_edit, office_help, office_inspect
from app.documents.pdf import apply_pdf_changes, inspect_pdf
from app.documents.schemas import FileToolRequest
from app.errors import AppError, conflict, invalid
from app.files.router import (
    file_out,
    get_owned_file,
    load_file_bytes,
    resolve_conversation_id,
    safe_filename,
)
from app.files.service import ensure_quota
from app.models import StoredFile
from app.storage import delete_object, put_object
from app.tools.files import (
    extract_document_text,
    file_text,
    grep_text,
    slice_text,
)
from app.utils import utcnow

CONTENT_TYPES = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "pdf": "application/pdf",
}
MODERN_FORMATS = {"docx", "xlsx", "pptx", "pdf"}
_FILE_ID_HINT = "请传 list 返回的 UUID 或草稿句柄（draft:…），不要传文件名。"

PDF_HELP = (
    "PDF 编辑支持：draw_text（在页面绘制文字）、replace_page（清空并重建整页）、"
    "add_page（新增页面）、remove_page（删除页面）、rotate_page（旋转页面）、"
    "set_field（填写文本表单字段）。坐标为 point，原点在页面左上角；page 从 1 开始。"
)


@dataclass
class Resolved:
    ref: str
    filename: str
    format: str
    data: bytes
    stored: StoredFile | None = None
    draft: Draft | None = None
    conversation_id: uuid.UUID | None = None


def detect_format(filename: str) -> str | None:
    suffix = PurePath(filename).suffix.lower().lstrip(".")
    if suffix in MODERN_FORMATS or suffix in LEGACY_FORMATS:
        return suffix
    return None


def _suffix(fmt: str) -> str:
    return f".{fmt}"


def _filename_for(fmt: str, requested: str | None, fallback: str | None = None) -> str:
    if requested:
        filename = safe_filename(requested)
        if PurePath(filename).suffix.lower().lstrip(".") != fmt:
            raise invalid(f"文件名扩展名必须为 .{fmt}。")
        return filename
    if fallback:
        base = PurePath(safe_filename(fallback))
        return f"{base.stem}{_suffix(fmt)}"
    return f"document{_suffix(fmt)}"


def _draft_ref(file_id: str) -> bool:
    return file_id.startswith("draft:")


async def _resolve(db: AsyncSession, user_id: uuid.UUID, file_id: str | None) -> Resolved:
    if not file_id:
        raise invalid("需要 fileId。")
    if _draft_ref(file_id):
        draft = await draft_store.drafts.get(user_id, file_id)
        data = await draft_store.drafts.read(draft)
        fmt = detect_format(draft.filename)
        if fmt is None:
            raise AppError(415, "unsupported_file_type", "不支持的文件类型。")
        return Resolved(
            ref=file_id,
            filename=draft.filename,
            format=fmt,
            data=data,
            draft=draft,
            conversation_id=draft.conversation_id,
        )
    try:
        stored_id = uuid.UUID(file_id)
    except ValueError as exc:
        raise invalid(f"fileId 不合法。{_FILE_ID_HINT}") from exc
    stored = await get_owned_file(db, user_id, stored_id)
    data = await load_file_bytes(stored)
    await db.close()
    fmt = detect_format(stored.filename)
    if fmt is None:
        raise AppError(415, "unsupported_file_type", "不支持的文件类型。")
    return Resolved(
        ref=file_id,
        filename=stored.filename,
        format=fmt,
        data=data,
        stored=stored,
        conversation_id=stored.conversation_id,
    )


async def _modernize(resolved: Resolved) -> tuple[str, str, bytes, bool]:
    if resolved.format in LEGACY_FORMATS:
        converted = await convert_legacy_office(resolved.filename, resolved.data)
        return converted.filename, converted.format, converted.data, True
    if resolved.format not in MODERN_FORMATS:
        raise AppError(415, "unsupported_file_type", "该文件不能用于文档操作。")
    return resolved.filename, resolved.format, resolved.data, False


async def run(db: AsyncSession, user_id: uuid.UUID, payload: FileToolRequest) -> dict[str, Any]:
    operation = payload.operation
    if operation == "list":
        return await _list(db, user_id, payload)
    if operation in {"read", "grep"}:
        return await _read(db, user_id, payload)
    if operation == "save":
        draft = await draft_store.drafts.get(user_id, payload.fileId or "")
        return await _persist(db, user_id, draft, payload.filename)
    if operation == "delete":
        return await _delete(db, user_id, payload)
    if operation == "help":
        return await _help(user_id, payload)

    resolved = await _resolve(db, user_id, payload.fileId) if operation in {"inspect", "edit"} else None
    if operation == "create":
        return await _create(db, user_id, payload)
    if operation == "inspect":
        assert resolved is not None
        return await _inspect(resolved, payload)
    if operation == "edit":
        assert resolved is not None
        return await _edit(db, user_id, payload, resolved)
    raise invalid("不支持的操作。")


async def _list(db: AsyncSession, user_id: uuid.UUID, payload: FileToolRequest) -> dict[str, Any]:
    # The chat client only knows its own conversation id; store the server id everywhere.
    conversation_id = None
    if payload.conversationId is not None:
        conversation_id = await resolve_conversation_id(db, user_id, str(payload.conversationId))
        if conversation_id is None:
            # An unknown scope must not fall back to account-wide files.
            return {"operation": "list", "files": []}

    stmt = select(StoredFile).where(StoredFile.user_id == user_id)
    if conversation_id is not None:
        stmt = stmt.where(StoredFile.conversation_id == conversation_id)
    stmt = stmt.order_by(StoredFile.created_at.desc()).limit(100)
    files = list((await db.execute(stmt)).scalars().all())
    items = [
        {
            "id": str(item.id),
            "filename": item.filename,
            "contentType": item.content_type,
            "size": item.size,
            "draft": False,
            "createdAt": item.created_at.timestamp() * 1000,
        }
        for item in files
    ]
    stored_drafts = await draft_store.drafts.list_for_user(user_id, conversation_id)
    items.extend(
        {
            "id": item.id,
            "filename": item.filename,
            "contentType": item.content_type,
            "size": item.size,
            "draft": True,
            "createdAt": item.created_at * 1000,
        }
        for item in stored_drafts
    )
    items.sort(key=lambda item: item["createdAt"], reverse=True)
    return {"operation": "list", "files": items[:100]}


async def _read(db: AsyncSession, user_id: uuid.UUID, payload: FileToolRequest) -> dict[str, Any]:
    if _draft_ref(payload.fileId or ""):
        draft = await draft_store.drafts.get(user_id, payload.fileId or "")
        data = await draft_store.drafts.read(draft)
        text = await extract_document_text(draft.filename, data)
        if payload.operation == "read":
            return {
                "operation": "read",
                **slice_text(draft.id, draft.filename, text, payload.start, payload.end, payload.maxChars),
            }
        assert payload.pattern is not None
        return {
            "operation": "grep",
            **grep_text(draft.id, draft.filename, text, payload.pattern, payload.context, payload.maxMatches),
        }

    try:
        stored_id = uuid.UUID(payload.fileId or "")
    except ValueError as exc:
        raise invalid(f"fileId 不合法。{_FILE_ID_HINT}") from exc
    stored = await get_owned_file(db, user_id, stored_id)
    await db.close()
    if payload.operation == "read":
        text = await file_text(stored)
        return {
            "operation": "read",
            **slice_text(str(stored.id), stored.filename, text, payload.start, payload.end, payload.maxChars),
        }
    assert payload.pattern is not None
    text = await file_text(stored)
    return {
        "operation": "grep",
        **grep_text(str(stored.id), stored.filename, text, payload.pattern, payload.context, payload.maxMatches),
    }


async def _help(user_id: uuid.UUID, payload: FileToolRequest) -> dict[str, Any]:
    fmt = payload.format
    if fmt is None and payload.fileId and _draft_ref(payload.fileId):
        draft = await draft_store.drafts.get(user_id, payload.fileId)
        fmt = detect_format(draft.filename)
    if fmt is None:
        raise invalid("需要 format 或带格式的文件。")
    if fmt == "pdf":
        return {"operation": "help", "format": "pdf", "text": PDF_HELP, "truncated": False}
    if fmt in LEGACY_FORMATS:
        fmt = LEGACY_FORMATS[fmt]
    resolve_officecli()
    text = await office_help(fmt, payload.element)
    return {"operation": "help", "format": fmt, "text": text, "truncated": len(text) >= 30_000}


async def _inspect(resolved: Resolved, payload: FileToolRequest) -> dict[str, Any]:
    filename, fmt, data, _ = await _modernize(resolved)
    if fmt == "pdf":
        text = await _pdf_call(inspect_pdf, data)
    else:
        resolve_officecli()
        text = await _engine_call(office_inspect(fmt, data, payload.path or "/"))
    return {"operation": "inspect", "fileId": resolved.ref, "format": fmt,
            "text": text, "truncated": len(text) >= 30_000}


async def _create(db: AsyncSession, user_id: uuid.UUID, payload: FileToolRequest) -> dict[str, Any]:
    fmt = payload.format or detect_format(payload.filename or "")
    if fmt is None:
        raise invalid("需要 format 或带格式的文件名。")
    if fmt in LEGACY_FORMATS:
        fmt = LEGACY_FORMATS[fmt]
    filename = _filename_for(fmt, payload.filename)
    data = await _apply(fmt, None, payload)
    conversation_id = (
        await resolve_conversation_id(db, user_id, str(payload.conversationId))
        if payload.conversationId is not None
        else None
    )
    draft = await draft_store.drafts.put(
        user_id=user_id,
        conversation_id=conversation_id,
        filename=filename,
        content_type=CONTENT_TYPES[fmt],
        data=data,
    )
    return await _finish(db, user_id, payload, draft)


async def _edit(
    db: AsyncSession, user_id: uuid.UUID, payload: FileToolRequest, resolved: Resolved
) -> dict[str, Any]:
    filename, fmt, data, converted = await _modernize(resolved)
    filename = _filename_for(fmt, payload.filename, filename)
    data = await _apply(fmt, data, payload)
    base_file_id = None if converted or resolved.stored is None else resolved.stored.id
    base_revision = None if converted or resolved.stored is None else resolved.stored.revision
    # The chat client sends its own conversation id; the file table only accepts server ids.
    scoped_id = (
        await resolve_conversation_id(db, user_id, str(payload.conversationId))
        if payload.conversationId is not None
        else None
    )
    conversation_id = scoped_id or resolved.conversation_id
    draft = await draft_store.drafts.put(
        user_id=user_id,
        conversation_id=conversation_id,
        filename=filename,
        content_type=CONTENT_TYPES[fmt],
        data=data,
        base_file_id=base_file_id,
        base_revision=base_revision,
        converted_from_legacy=converted,
        draft_id=resolved.draft.id if resolved.draft and not converted else None,
    )
    return await _finish(db, user_id, payload, draft)


async def _apply(fmt: str, data: bytes | None, payload: FileToolRequest) -> bytes:
    if fmt == "pdf":
        if payload.commands:
            raise invalid("PDF 文档不支持 commands，请使用 pdfChanges。")
        changes = payload.pdfChanges or []
        return await _pdf_call(apply_pdf_changes, data, changes)
    if payload.pdfChanges:
        raise invalid("Office 文档不支持 pdfChanges，请使用 commands。")
    resolve_officecli()
    if data is None:
        data = await _engine_call(office_create(fmt))
    if payload.commands:
        data = await _engine_call(office_edit(fmt, data, payload.commands))
    return data


async def _finish(db: AsyncSession, user_id: uuid.UUID, payload: FileToolRequest, draft: Draft) -> dict[str, Any]:
    if payload.save:
        published = await _persist(db, user_id, draft, payload.filename)
        return {**published, "operation": payload.operation}
    assert draft is not None
    return {"operation": payload.operation, "draft": draft.summary()}


async def _persist(
    db: AsyncSession, user_id: uuid.UUID, draft: Draft, requested_name: str | None
) -> dict[str, Any]:
    fmt = detect_format(draft.filename)
    if fmt not in MODERN_FORMATS:
        raise invalid("草稿格式不合法。")
    filename = _filename_for(fmt, requested_name, draft.filename)
    data = await draft_store.drafts.read(draft)
    content_type = CONTENT_TYPES[fmt]
    digest = hashlib.sha256(data).hexdigest()
    suffix = _suffix(fmt)

    if draft.base_file_id is not None:
        stored = await get_owned_file(db, user_id, draft.base_file_id)
        if draft.base_revision is not None and stored.revision != draft.base_revision:
            raise conflict("文件已在其他设备更新，请重新打开后再编辑。", current=file_out(stored))
        await ensure_quota(db, user_id, len(data), replacing=stored.size)
        old_key = stored.object_key
        new_key = f"users/{user_id}/{stored.id}/{uuid.uuid4().hex}{suffix}"
        try:
            await asyncio.to_thread(put_object, new_key, data, content_type)
        except Exception as exc:  # noqa: BLE001
            raise AppError(502, "storage_error", "文件保存失败，请稍后重试。") from exc
        stored.object_key = new_key
        stored.filename = filename
        stored.content_type = content_type
        stored.size = len(data)
        stored.sha256 = digest
        stored.revision += 1
        stored.updated_at = utcnow()
        try:
            await db.commit()
        except Exception:
            await db.rollback()
            await asyncio.to_thread(delete_object, new_key)
            raise
        await asyncio.to_thread(delete_object, old_key)
    else:
        await ensure_quota(db, user_id, len(data))
        file_id = uuid.uuid4()
        object_key = f"users/{user_id}/{file_id}/{uuid.uuid4().hex}{suffix}"
        try:
            await asyncio.to_thread(put_object, object_key, data, content_type)
        except Exception as exc:  # noqa: BLE001
            raise AppError(502, "storage_error", "文件保存失败，请稍后重试。") from exc
        stored = StoredFile(
            id=file_id,
            user_id=user_id,
            conversation_id=draft.conversation_id,
            filename=filename,
            object_key=object_key,
            content_type=content_type,
            size=len(data),
            sha256=digest,
        )
        db.add(stored)
        try:
            await db.commit()
        except Exception:
            await db.rollback()
            await asyncio.to_thread(delete_object, object_key)
            raise

    await draft_store.drafts.delete(user_id, draft.id)
    return {"operation": "save", "file": file_out(stored)}


async def _delete(db: AsyncSession, user_id: uuid.UUID, payload: FileToolRequest) -> dict[str, Any]:
    file_id = payload.fileId or ""
    if _draft_ref(file_id):
        draft = await draft_store.drafts.get(user_id, file_id)
        await draft_store.drafts.delete(user_id, file_id)
        return {"operation": "delete", "fileId": file_id, "filename": draft.filename, "draft": True}

    try:
        stored_id = uuid.UUID(file_id)
    except ValueError as exc:
        raise invalid(f"fileId 不合法。{_FILE_ID_HINT}") from exc
    stored = await get_owned_file(db, user_id, stored_id)
    filename = stored.filename
    # Match the Library endpoint: remove the object first, then the row. An orphaned object is
    # recoverable, but a row pointing at a deleted object is not.
    await db.close()
    await asyncio.to_thread(delete_object, stored.object_key)
    await db.delete(stored)
    await db.commit()
    return {"operation": "delete", "fileId": str(stored_id), "filename": filename}


async def _engine_call(coro: Coroutine[Any, Any, Any]) -> Any:
    timeout = get_settings().document_tool_timeout_seconds
    try:
        return await asyncio.wait_for(coro, timeout)
    except TimeoutError as exc:
        raise AppError(504, "officecli_timeout", "文档处理超时，请重试。") from exc


async def _pdf_call(function: Any, *args: Any) -> Any:
    timeout = get_settings().document_tool_timeout_seconds
    try:
        return await asyncio.wait_for(asyncio.to_thread(function, *args), timeout)
    except TimeoutError as exc:
        raise AppError(504, "document_engine_error", "PDF 处理超时，请重试。") from exc


