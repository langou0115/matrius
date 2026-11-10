import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select, tuple_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.conversations.schemas import (
    ConversationCreate,
    ConversationPatch,
    MessageCreate,
    MessagePatch,
    activities_payload,
    process_payload,
)
from app.conversations.serializers import conversation_out, message_out
from app.db import get_db
from app.errors import conflict, invalid, not_found
from app.features.dependencies import require_feature
from app.instance.dependencies import InstanceContext, read_rate_limit, write_rate_limit
from app.models import Conversation, ConversationDeletion, Message, StoredFile
from app.utils import (
    clamp_page_size,
    decode_cursor,
    encode_cursor,
    ensure_aware,
    to_ms,
    utcnow,
    validate_client_id,
)
from app.workspace.import_service import _import_lock, record_conversation_deletion

router = APIRouter(prefix="/api", tags=["conversations"])


async def _get_conversation(
    db: AsyncSession, instance_id: int, conversation_id: uuid.UUID, *, lock: bool = False
) -> Conversation:
    stmt = select(Conversation).where(
        Conversation.id == conversation_id, Conversation.instance_id == instance_id
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
    instance_id: int,
    item_id: uuid.UUID | None,
    client_id: str | None,
) -> Any:
    if item_id is not None:
        existing = (
            await db.execute(select(model).where(model.id == item_id))
        ).scalar_one_or_none()
        if existing is not None:
            if existing.instance_id != instance_id:
                raise conflict("该标识已被占用。")
            return existing
    if client_id is not None:
        return (
            await db.execute(
                select(model).where(model.instance_id == instance_id, model.client_id == client_id)
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
    ctx: InstanceContext = Depends(read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    page_size = clamp_page_size(limit)
    stmt = select(Conversation).where(Conversation.instance_id == ctx.instance_id)
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
    ctx: InstanceContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    async with _import_lock():
        return await _create_conversation_record(payload, ctx, db)


async def _create_conversation_record(
    payload: ConversationCreate, ctx: InstanceContext, db: AsyncSession,
) -> dict[str, Any]:
    client_id = validate_client_id(payload.clientId)
    for identity in (client_id, str(payload.id) if payload.id else None):
        if identity and await db.get(ConversationDeletion, (ctx.instance_id, identity)) is not None:
            raise conflict("对话已删除，请创建新的对话。")
    existing = await _find_by_id_or_client(db, Conversation, ctx.instance_id, payload.id, client_id)
    if existing is not None:
        return conversation_out(existing)

    conversation = Conversation(
        id=payload.id or uuid.uuid4(),
        instance_id=ctx.instance_id,
        client_id=client_id,
        title=payload.title,
        pinned=payload.pinned,
        model_id=payload.modelId,
        title_source=payload.titleSource,
        context_summary=payload.contextSummary.model_dump() if payload.contextSummary else None,
        client_updated_at_ms=payload.updatedAt,
    )
    db.add(conversation)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing = await _find_by_id_or_client(db, Conversation, ctx.instance_id, payload.id, client_id)
        if existing is not None:
            return conversation_out(existing)
        raise conflict("对话已存在，请刷新后重试。") from None
    return conversation_out(conversation)


@router.get("/conversations/{conversation_id}")
async def get_conversation(
    conversation_id: uuid.UUID,
    messageLimit: int = Query(default=50, ge=1),
    before: str | None = None,
    ctx: InstanceContext = Depends(read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    conversation = await _get_conversation(db, ctx.instance_id, conversation_id)
    page_size = clamp_page_size(messageLimit)

    stmt = select(Message).where(Message.conversation_id == conversation.id)
    if before:
        stmt = stmt.where(Message.position < _parse_message_cursor(before))
    stmt = stmt.order_by(Message.position.desc()).limit(page_size + 1)

    rows = list((await db.execute(stmt)).scalars().all())
    has_more = len(rows) > page_size
    rows = rows[:page_size]
    rows.reverse()
    # One query for the whole page: a per-message lookup would multiply SQLite round trips.
    files_by_id = await _load_files(
        db, ctx.instance_id, [file_id for item in rows for file_id in (item.file_ids or [])]
    )
    return {
        "conversation": conversation_out(conversation),
        "messages": [message_out(item, files_by_id) for item in rows],
        "nextCursor": encode_cursor(str(rows[0].position)) if has_more and rows else None,
    }


async def _load_files(
    db: AsyncSession, instance_id: int, file_ids: list[str]
) -> dict[str, StoredFile]:
    parsed: list[uuid.UUID] = []
    for raw in dict.fromkeys(file_ids):
        try:
            parsed.append(uuid.UUID(raw))
        except ValueError:
            continue
    if not parsed:
        return {}
    files = (
        await db.execute(
            select(StoredFile).where(StoredFile.id.in_(parsed), StoredFile.instance_id == instance_id)
        )
    ).scalars().all()
    return {str(item.id): item for item in files}


@router.patch("/conversations/{conversation_id}")
async def update_conversation(
    conversation_id: uuid.UUID,
    payload: ConversationPatch,
    ctx: InstanceContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    conversation = await _get_conversation(db, ctx.instance_id, conversation_id, lock=True)
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
    if "contextSummary" in fields:
        conversation.context_summary = (
            payload.contextSummary.model_dump() if payload.contextSummary is not None else None
        )
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
    ctx: InstanceContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    async with _import_lock():
        conversation = await _get_conversation(db, ctx.instance_id, conversation_id, lock=True)
        if conversation.revision != baseRevision:
            raise conflict("对话已在其他设备更新，请刷新后重试。", current=conversation_out(conversation))
        await record_conversation_deletion(db, ctx.instance_id, str(conversation.id))
        if conversation.client_id:
            await record_conversation_deletion(db, ctx.instance_id, conversation.client_id)
        await db.delete(conversation)
        await db.commit()
    return {"ok": True}


async def _attach_files(
    db: AsyncSession, instance_id: int, conversation_id: uuid.UUID, file_ids: list[uuid.UUID]
) -> list[StoredFile]:
    unique_ids = list(dict.fromkeys(file_ids))
    if not unique_ids:
        return []
    files = list(
        (
            await db.execute(
                select(StoredFile).where(StoredFile.id.in_(unique_ids), StoredFile.instance_id == instance_id)
            )
        )
        .scalars()
        .all()
    )
    if len(files) != len(unique_ids):
        raise invalid("文件不存在或不属于当前用户。")
    # Preserve the order the message declared rather than the database's.
    by_id = {item.id: item for item in files}
    ordered = [by_id[file_id] for file_id in unique_ids]
    for stored in ordered:
        if stored.conversation_id is None:
            stored.conversation_id = conversation_id
        elif stored.conversation_id != conversation_id:
            raise invalid("文件属于其他对话。")
    return ordered


@router.post("/conversations/{conversation_id}/messages", status_code=201)
async def create_message(
    conversation_id: uuid.UUID,
    payload: MessageCreate,
    ctx: InstanceContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    if payload.uiArtifacts:
        await require_feature("generative-ui")(ctx)
        if payload.role != "assistant":
            raise invalid("UI artifacts require an assistant message.")
    client_id = validate_client_id(payload.clientId)
    existing = await _find_by_id_or_client(db, Message, ctx.instance_id, payload.id, client_id)
    if existing is not None:
        if existing.conversation_id != conversation_id:
            raise conflict("消息标识已被其他对话使用。")
        return message_out(existing, await _load_files(db, ctx.instance_id, existing.file_ids or []))

    conversation = await _get_conversation(db, ctx.instance_id, conversation_id, lock=True)

    next_position = (
        await db.execute(
            select(func.coalesce(func.max(Message.position), 0)).where(
                Message.conversation_id == conversation.id
            )
        )
    ).scalar_one() + 1

    stored_files = await _attach_files(db, ctx.instance_id, conversation.id, payload.fileIds)
    stored_file_ids = [str(item.id) for item in stored_files]
    status = "complete" if payload.role == "user" else payload.status
    message = Message(
        id=payload.id or uuid.uuid4(),
        instance_id=ctx.instance_id,
        conversation_id=conversation.id,
        client_id=client_id,
        position=next_position,
        role=payload.role,
        content=payload.content,
        steering=payload.steering and payload.role == "user",
        quote=payload.quote,
        feedback=payload.feedback,
        reasoning=payload.reasoning,
        activities=activities_payload(payload.activities),
        process=process_payload(payload.process),
        ui_artifacts=[item.model_dump(exclude_none=True) for item in payload.uiArtifacts] or None,
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
        existing = await _find_by_id_or_client(db, Message, ctx.instance_id, payload.id, client_id)
        if existing is not None:
            return message_out(existing, await _load_files(db, ctx.instance_id, existing.file_ids or []))
        raise conflict("消息写入冲突，请重试。") from None
    return message_out(message, {str(item.id): item for item in stored_files})


async def _get_message(db: AsyncSession, instance_id: int, message_id: uuid.UUID) -> Message:
    message = (
        await db.execute(
            select(Message)
            .where(Message.id == message_id, Message.instance_id == instance_id)
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
    ctx: InstanceContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    message = await _get_message(db, ctx.instance_id, message_id)
    if message.revision != payload.baseRevision:
        raise conflict("消息已在其他设备更新，请刷新后重试。", current=message_out(message))

    fields = payload.model_dump(exclude_unset=True)
    for name in ("content", "quote", "reasoning", "thinkingMs", "status", "error", "feedback"):
        if name not in fields:
            continue
        if fields[name] is None and name in ("content", "status"):
            raise invalid("消息正文和状态不能为空。")
        if name == "status" and message.role == "user" and payload.status != "complete":
            raise invalid("用户消息状态必须为 complete。")
        setattr(message, _snake(name), fields[name])
    if "activities" in fields:
        message.activities = activities_payload(payload.activities)
    if "uiArtifacts" in fields:
        if payload.uiArtifacts:
            await require_feature("generative-ui")(ctx)
            if message.role != "assistant":
                raise invalid("UI artifacts require an assistant message.")
        message.ui_artifacts = [item.model_dump(exclude_none=True) for item in payload.uiArtifacts or []] or None
    if "process" in fields:
        message.process = process_payload(payload.process)

    attached: list[StoredFile] = []
    if "fileIds" in fields:
        attached = await _attach_files(
            db, ctx.instance_id, message.conversation_id, payload.fileIds or []
        )
        message.file_ids = [str(item.id) for item in attached]

    message.revision += 1
    message.updated_at = utcnow()
    await db.commit()
    files_by_id = (
        {str(item.id): item for item in attached}
        if attached
        else await _load_files(db, ctx.instance_id, message.file_ids or [])
    )
    return message_out(message, files_by_id)


def _snake(name: str) -> str:
    return {
        "thinkingMs": "thinking_ms",
    }.get(name, name)


@router.delete("/messages/{message_id}")
async def delete_message(
    message_id: uuid.UUID,
    baseRevision: int = Query(ge=1),
    ctx: InstanceContext = Depends(write_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    message = await _get_message(db, ctx.instance_id, message_id)
    if message.revision != baseRevision:
        raise conflict("消息已在其他设备更新，请刷新后重试。", current=message_out(message))
    await db.delete(message)
    await db.commit()
    return {"ok": True}
