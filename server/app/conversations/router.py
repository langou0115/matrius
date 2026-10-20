import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select, tuple_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import AuthContext, read_rate_limit, write_rate_limit
from app.conversations.schemas import (
    ConversationCreate,
    ConversationPatch,
    MessageCreate,
    MessagePatch,
)
from app.conversations.serializers import conversation_out, message_out
from app.db import get_db
from app.errors import conflict, invalid, not_found
from app.models import Conversation, Message, StoredFile
from app.utils import (
    clamp_page_size,
    decode_cursor,
    encode_cursor,
    ensure_aware,
    to_ms,
    utcnow,
    validate_client_id,
)

router = APIRouter(prefix="/api", tags=["conversations"])


async def _get_conversation(
    db: AsyncSession, user_id: uuid.UUID, conversation_id: uuid.UUID, *, lock: bool = False
) -> Conversation:
    stmt = select(Conversation).where(
        Conversation.id == conversation_id, Conversation.user_id == user_id
    )
    if lock:
        stmt = stmt.with_for_update()
    conversation = (await db.execute(stmt)).scalar_one_or_none()
    if conversation is None:
        raise not_found("对话不存在。")
    return conversation


async def _find_by_id_or_client(
    db: AsyncSession,
    model: type[Conversation] | type[Message],
    user_id: uuid.UUID,
    item_id: uuid.UUID | None,
    client_id: str | None,
) -> Any:
    if item_id is not None:
        existing = (
            await db.execute(select(model).where(model.id == item_id))
        ).scalar_one_or_none()
        if existing is not None:
            if existing.user_id != user_id:
                raise conflict("该标识已被占用。")
            return existing
    if client_id is not None:
        return (
            await db.execute(
                select(model).where(model.user_id == user_id, model.client_id == client_id)
            )
        ).scalar_one_or_none()
    return None


def _parse_cursor(cursor: str) -> tuple[bool, datetime, uuid.UUID]:
    pinned_raw, updated_raw, id_raw = decode_cursor(cursor, 3)
    try:
        pinned = pinned_raw == "1"
        updated_at = datetime.fromisoformat(updated_raw)
        item_id = uuid.UUID(id_raw)
    except (ValueError, TypeError) as exc:
        raise invalid("分页游标无效。") from exc
    return pinned, ensure_aware(updated_at), item_id


def _next_conversation_cursor(conversation: Conversation) -> str:
    return encode_cursor(
        "1" if conversation.pinned else "0",
        ensure_aware(conversation.updated_at).isoformat(),
        str(conversation.id),
    )


def _parse_message_cursor(cursor: str) -> int:
    (raw,) = decode_cursor(cursor, 1)
    try:
        return int(raw)
    except ValueError as exc:
        raise invalid("分页游标无效。") from exc


@router.get("/conversations")
async def list_conversations(
    limit: int = Query(default=50, ge=1),
    cursor: str | None = None,
    ctx: AuthContext = Depends(read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    page_size = clamp_page_size(limit)
    stmt = select(Conversation).where(Conversation.user_id == ctx.user.id)
    if cursor:
        pinned, updated_at, conversation_id = _parse_cursor(cursor)
        stmt = stmt.where(
            tuple_(Conversation.pinned, Conversation.updated_at, Conversation.id)
            < tuple_(pinned, updated_at, conversation_id)
        )
    stmt = stmt.order_by(
        Conversation.pinned.desc(), Conversation.updated_at.desc(), Conversation.id.desc()
    ).limit(page_size + 1)

    rows = list((await db.execute(stmt)).scalars().all())
    has_more = len(rows) > page_size
    rows = rows[:page_size]
    return {
        "items": [conversation_out(item) for item in rows],
        "nextCursor": _next_conversation_cursor(rows[-1]) if has_more and rows else None,
    }


@router.post("/conversations", status_code=201)
async def create_conversation(
    payload: ConversationCreate,
    ctx: AuthContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    client_id = validate_client_id(payload.clientId)
    existing = await _find_by_id_or_client(db, Conversation, ctx.user.id, payload.id, client_id)
    if existing is not None:
        return conversation_out(existing)

    conversation = Conversation(
        id=payload.id or uuid.uuid4(),
        user_id=ctx.user.id,
        client_id=client_id,
        title=payload.title,
        pinned=payload.pinned,
        model_id=payload.modelId,
        title_source=payload.titleSource,
        client_updated_at_ms=payload.updatedAt,
    )
    db.add(conversation)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing = await _find_by_id_or_client(db, Conversation, ctx.user.id, payload.id, client_id)
        if existing is not None:
            return conversation_out(existing)
        raise conflict("对话已存在，请刷新后重试。") from None
    return conversation_out(conversation)


@router.get("/conversations/{conversation_id}")
async def get_conversation(
    conversation_id: uuid.UUID,
    messageLimit: int = Query(default=50, ge=1),
    before: str | None = None,
    ctx: AuthContext = Depends(read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    conversation = await _get_conversation(db, ctx.user.id, conversation_id)
    page_size = clamp_page_size(messageLimit)

    stmt = select(Message).where(Message.conversation_id == conversation.id)
    if before:
        stmt = stmt.where(Message.position < _parse_message_cursor(before))
    stmt = stmt.order_by(Message.position.desc()).limit(page_size + 1)

    rows = list((await db.execute(stmt)).scalars().all())
    has_more = len(rows) > page_size
    rows = rows[:page_size]
    rows.reverse()
    return {
        "conversation": conversation_out(conversation),
        "messages": [message_out(item) for item in rows],
        "nextCursor": encode_cursor(str(rows[0].position)) if has_more and rows else None,
    }


@router.patch("/conversations/{conversation_id}")
async def update_conversation(
    conversation_id: uuid.UUID,
    payload: ConversationPatch,
    ctx: AuthContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    conversation = await _get_conversation(db, ctx.user.id, conversation_id, lock=True)
    if conversation.revision != payload.baseRevision:
        raise conflict("对话已在其他设备更新，请刷新后重试。", current=conversation_out(conversation))

    fields = payload.model_dump(exclude_unset=True)
    changed = False

    if fields.get("title") is not None:
        conversation.title = payload.title
        changed = True
    if fields.get("pinned") is not None:
        conversation.pinned = payload.pinned
        changed = True
    if "modelId" in fields:
        conversation.model_id = payload.modelId
        changed = True
    if "titleSource" in fields:
        conversation.title_source = payload.titleSource
        changed = True

    if payload.readState is not None:
        for name in ("completed", "error"):
            marker = getattr(payload.readState, name)
            if marker is None:
                continue
            read_at = None
            if marker.state == "read":
                read_at = marker.readAt if marker.readAt is not None else to_ms(utcnow())
            if name == "completed":
                conversation.completed_state = marker.state
                conversation.completed_read_at_ms = read_at
            else:
                conversation.error_state = marker.state
                conversation.error_read_at_ms = read_at
            changed = True

    if changed:
        conversation.revision += 1
        await db.commit()
    return conversation_out(conversation)


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(
    conversation_id: uuid.UUID,
    baseRevision: int = Query(ge=1),
    ctx: AuthContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    conversation = await _get_conversation(db, ctx.user.id, conversation_id, lock=True)
    if conversation.revision != baseRevision:
        raise conflict("对话已在其他设备更新，请刷新后重试。", current=conversation_out(conversation))
    await db.delete(conversation)
    await db.commit()
    return {"ok": True}


async def _attach_files(
    db: AsyncSession, user_id: uuid.UUID, conversation_id: uuid.UUID, file_ids: list[uuid.UUID]
) -> list[str]:
    unique_ids = list(dict.fromkeys(file_ids))
    if not unique_ids:
        return []
    files = list(
        (
            await db.execute(
                select(StoredFile).where(StoredFile.id.in_(unique_ids), StoredFile.user_id == user_id)
            )
        )
        .scalars()
        .all()
    )
    if len(files) != len(unique_ids):
        raise invalid("文件不存在或不属于当前用户。")
    for stored in files:
        if stored.conversation_id is None:
            stored.conversation_id = conversation_id
    return [str(stored.id) for stored in files]


@router.post("/conversations/{conversation_id}/messages", status_code=201)
async def create_message(
    conversation_id: uuid.UUID,
    payload: MessageCreate,
    ctx: AuthContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    client_id = validate_client_id(payload.clientId)
    existing = await _find_by_id_or_client(db, Message, ctx.user.id, payload.id, client_id)
    if existing is not None:
        if existing.conversation_id != conversation_id:
            raise conflict("消息标识已被其他对话使用。")
        return message_out(existing)

    conversation = await _get_conversation(db, ctx.user.id, conversation_id, lock=True)

    next_position = (
        await db.execute(
            select(func.coalesce(func.max(Message.position), 0)).where(
                Message.conversation_id == conversation.id
            )
        )
    ).scalar_one() + 1

    stored_file_ids = await _attach_files(db, ctx.user.id, conversation.id, payload.fileIds)
    status = "complete" if payload.role == "user" else payload.status
    message = Message(
        id=payload.id or uuid.uuid4(),
        user_id=ctx.user.id,
        conversation_id=conversation.id,
        client_id=client_id,
        position=next_position,
        role=payload.role,
        content=payload.content,
        quote=payload.quote,
        feedback=payload.feedback,
        reasoning=payload.reasoning,
        thinking_ms=payload.thinkingMs,
        status=status,
        error=payload.error,
        file_ids=stored_file_ids,
    )
    db.add(message)

    conversation.updated_at = utcnow()
    if payload.role == "assistant":
        if status == "error":
            conversation.error_state = "unread"
            conversation.error_read_at_ms = None
        else:
            conversation.completed_state = "unread"
            conversation.completed_read_at_ms = None

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing = await _find_by_id_or_client(db, Message, ctx.user.id, payload.id, client_id)
        if existing is not None:
            return message_out(existing)
        raise conflict("消息写入冲突，请重试。") from None
    return message_out(message)


async def _get_message(db: AsyncSession, user_id: uuid.UUID, message_id: uuid.UUID) -> Message:
    message = (
        await db.execute(
            select(Message)
            .where(Message.id == message_id, Message.user_id == user_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if message is None:
        raise not_found("消息不存在。")
    return message


@router.patch("/messages/{message_id}")
async def update_message(
    message_id: uuid.UUID,
    payload: MessagePatch,
    ctx: AuthContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    message = await _get_message(db, ctx.user.id, message_id)
    if message.revision != payload.baseRevision:
        raise conflict("消息已在其他设备更新，请刷新后重试。", current=message_out(message))

    fields = payload.model_dump(exclude_unset=True)
    for name in ("content", "quote", "reasoning", "thinkingMs", "status", "error", "feedback"):
        if name not in fields or fields[name] is None:
            continue
        if name == "status" and message.role == "user" and payload.status != "complete":
            raise invalid("用户消息状态必须为 complete。")
        setattr(message, _snake(name), fields[name])

    message.revision += 1
    message.updated_at = utcnow()
    await db.commit()
    return message_out(message)


def _snake(name: str) -> str:
    return {
        "thinkingMs": "thinking_ms",
    }.get(name, name)


@router.delete("/messages/{message_id}")
async def delete_message(
    message_id: uuid.UUID,
    baseRevision: int = Query(ge=1),
    ctx: AuthContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    message = await _get_message(db, ctx.user.id, message_id)
    if message.revision != baseRevision:
        raise conflict("消息已在其他设备更新，请刷新后重试。", current=message_out(message))
    await db.delete(message)
    await db.commit()
    return {"ok": True}
