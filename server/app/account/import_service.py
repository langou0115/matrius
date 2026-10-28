import asyncio
import logging
import uuid
import weakref
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.account.schemas import ImportConversation, ImportMessage, ImportReadState, ImportRequest
from app.conversations.schemas import activities_payload
from app.errors import invalid
from app.models import Conversation, ConversationDeletion, Message, UserPreference, UserProfile
from app.utils import to_ms, utcnow, validate_client_id

logger = logging.getLogger(__name__)

MAX_CONVERSATIONS = 20
MAX_MESSAGES = 2000
MAX_IMPORT_BYTES = 8 * 1024 * 1024

# Imports are read-modify-write transactions. SQLite serialises writers anyway, but two
# imports racing on the same client id would both read "missing" and one would fail the
# unique constraint. The API runs as a single worker, so an in-process lock removes that
# race (including sync requests from several tabs) without changing the storage contract.
# The lock is per event loop so test suites that create a fresh loop per test stay isolated.
_IMPORT_LOCKS: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock]" = (
    weakref.WeakKeyDictionary()
)


def _import_lock() -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    lock = _IMPORT_LOCKS.get(loop)
    if lock is None:
        lock = asyncio.Lock()
        _IMPORT_LOCKS[loop] = lock
    return lock


async def record_conversation_deletion(db: AsyncSession, user_id: uuid.UUID, client_id: str) -> None:
    if await db.get(ConversationDeletion, (user_id, client_id)) is None:
        db.add(ConversationDeletion(user_id=user_id, client_id=client_id))
        await db.flush()


async def _delete_conversations(db: AsyncSession, user_id: uuid.UUID, ids: list[str]) -> None:
    for raw_id in set(ids):
        client_id = validate_client_id(raw_id)
        await record_conversation_deletion(db, user_id, client_id)
        try:
            server_id = uuid.UUID(client_id)
        except ValueError:
            server_id = None
        rows = (await db.execute(select(Conversation).where(
            Conversation.user_id == user_id,
            or_(Conversation.client_id == client_id, Conversation.id == server_id),
        ))).scalars().all()
        for conversation in rows:
            await record_conversation_deletion(db, user_id, str(conversation.id))
            if conversation.client_id:
                await record_conversation_deletion(db, user_id, conversation.client_id)
            await db.delete(conversation)
        await db.flush()


def _client_time(ms: int | None) -> datetime:
    if not ms or ms <= 0:
        return utcnow()
    try:
        value = datetime.fromtimestamp(ms / 1000, UTC)
    except (OverflowError, OSError, ValueError):
        return utcnow()
    return min(value, utcnow())


def _message_client_id(raw: str | None) -> str | None:
    if raw is None:
        return None
    try:
        return validate_client_id(raw)
    except Exception:  # noqa: BLE001 - malformed local ids are simply dropped
        return None


def _message_values(message: ImportMessage) -> dict[str, Any]:
    return {
        "content": message.content,
        "steering": message.steering and message.role == "user",
        "quote": message.quote,
        "feedback": message.feedback,
        "reasoning": message.reasoning,
        "activities": activities_payload(message.activities),
        "thinking_ms": message.thinkingMs,
        "status": "complete" if message.role == "user" else message.status,
        "error": message.error,
    }


def _apply_message(existing: Message, message: ImportMessage) -> bool:
    changed = False
    for name, value in _message_values(message).items():
        if getattr(existing, name) != value:
            setattr(existing, name, value)
            changed = True
    if changed:
        existing.revision += 1
        existing.updated_at = utcnow()
    return changed


def _apply_read_state(conversation: Conversation, read_state: ImportReadState) -> bool:
    changed = False
    now = to_ms(utcnow())
    for name, marker in (("completed", read_state.completed), ("error", read_state.error)):
        if marker is None:
            continue
        read_at = marker.readAt if marker.readAt is not None else now if marker.state == "read" else None
        if name == "completed":
            if (conversation.completed_state, conversation.completed_read_at_ms) != (marker.state, read_at):
                conversation.completed_state = marker.state
                conversation.completed_read_at_ms = read_at
                changed = True
        elif (conversation.error_state, conversation.error_read_at_ms) != (marker.state, read_at):
            conversation.error_state = marker.state
            conversation.error_read_at_ms = read_at
            changed = True
    return changed


def _apply_metadata(conversation: Conversation, item: ImportConversation) -> bool:
    changed = False
    values = {
        "title": item.title,
        "pinned": item.pinned,
        "model_id": item.modelId,
        "title_source": item.titleSource,
        "context_summary": item.contextSummary.model_dump() if item.contextSummary else None,
    }
    for name, value in values.items():
        if getattr(conversation, name) != value:
            setattr(conversation, name, value)
            changed = True
    return changed


async def _import_settings(db: AsyncSession, user_id: uuid.UUID, payload: ImportRequest) -> None:
    if payload.appearance is not None:
        existing = (
            await db.execute(select(UserPreference).where(UserPreference.user_id == user_id))
        ).scalar_one_or_none()
        if existing is None:
            db.add(
                UserPreference(
                    user_id=user_id,
                    theme_id=payload.appearance.themeId,
                    mode=payload.appearance.mode,
                )
            )
        elif (existing.theme_id, existing.mode) != (
            payload.appearance.themeId,
            payload.appearance.mode,
        ):
            existing.theme_id = payload.appearance.themeId
            existing.mode = payload.appearance.mode
            existing.revision += 1

    if payload.personalization is not None:
        existing = (
            await db.execute(select(UserProfile).where(UserProfile.user_id == user_id))
        ).scalar_one_or_none()
        values = {
            "custom_instructions": payload.personalization.customInstructions,
            "about_name": payload.personalization.aboutName,
            "occupation": payload.personalization.occupation,
            "about_more": payload.personalization.aboutMore,
        }
        if existing is None:
            db.add(UserProfile(user_id=user_id, **values))
        elif any(getattr(existing, name) != value for name, value in values.items()):
            for name, value in values.items():
                setattr(existing, name, value)
            existing.revision += 1


async def _create_conversation(
    db: AsyncSession, user_id: uuid.UUID, client_id: str, item: ImportConversation,
    messages: list[tuple[ImportMessage, str | None]],
) -> int:
    conversation = Conversation(
        user_id=user_id,
        client_id=client_id,
        title=item.title,
        pinned=item.pinned,
        model_id=item.modelId,
        title_source=item.titleSource,
        context_summary=item.contextSummary.model_dump() if item.contextSummary else None,
        client_updated_at_ms=item.updatedAt,
        updated_at=_client_time(item.updatedAt),
    )
    db.add(conversation)
    await db.flush()

    for index, (message, message_client_id) in enumerate(messages, start=1):
        db.add(
            Message(
                user_id=user_id,
                conversation_id=conversation.id,
                client_id=message_client_id,
                position=index,
                role=message.role,
                content=message.content,
                steering=message.steering and message.role == "user",
                quote=message.quote,
                feedback=message.feedback,
                reasoning=message.reasoning,
                activities=activities_payload(message.activities),
                thinking_ms=message.thinkingMs,
                status="complete" if message.role == "user" else message.status,
                error=message.error,
            )
        )
    if item.readState is not None:
        _apply_read_state(conversation, item.readState)
    await db.flush()
    return len(messages)


async def _merge_conversation(
    db: AsyncSession, user_id: uuid.UUID, existing: Conversation, item: ImportConversation,
    messages: list[tuple[ImportMessage, str | None]],
) -> tuple[int, bool]:
    stored = list(
        (
            await db.execute(select(Message).where(Message.conversation_id == existing.id))
        ).scalars()
    )
    by_client_id = {message.client_id: message for message in stored if message.client_id is not None}
    next_position = max((message.position for message in stored), default=0)
    changed = False
    added = 0

    for message, message_client_id in messages:
        # Without a client id a message cannot be matched to its stored copy, so an existing
        # conversation only ever receives messages that can be deduplicated.
        if message_client_id is None:
            continue
        found = by_client_id.get(message_client_id)
        if found is not None:
            changed = _apply_message(found, message) or changed
            continue
        next_position += 1
        db.add(
            Message(
                user_id=user_id,
                conversation_id=existing.id,
                client_id=message_client_id,
                position=next_position,
                role=message.role,
                content=message.content,
                steering=message.steering and message.role == "user",
                quote=message.quote,
                feedback=message.feedback,
                reasoning=message.reasoning,
                activities=activities_payload(message.activities),
                thinking_ms=message.thinkingMs,
                status="complete" if message.role == "user" else message.status,
                error=message.error,
            )
        )
        changed = True
        added += 1

    if item.readState is not None:
        changed = _apply_read_state(existing, item.readState) or changed

    # Metadata only wins when the local copy is at least as new as the last uploaded one.
    if item.updatedAt is not None and item.updatedAt >= (existing.client_updated_at_ms or 0):
        changed = _apply_metadata(existing, item) or changed
        existing.client_updated_at_ms = item.updatedAt

    if not changed:
        return 0, False
    existing.revision += 1
    existing.updated_at = _client_time(item.updatedAt) if item.updatedAt is not None else utcnow()
    return added, True


async def run_import(db: AsyncSession, user_id: uuid.UUID, payload: ImportRequest) -> dict[str, Any]:
    async with _import_lock():
        return await _run_import(db, user_id, payload)


async def _run_import(db: AsyncSession, user_id: uuid.UUID, payload: ImportRequest) -> dict[str, Any]:
    if payload.schemaVersion != 1:
        raise invalid("不支持的导入数据版本。")

    conversations = payload.chat.conversations
    total_messages = sum(len(item.messages) for item in conversations)
    if len(conversations) > MAX_CONVERSATIONS:
        raise invalid(f"单批最多导入 {MAX_CONVERSATIONS} 个对话。")
    if total_messages > MAX_MESSAGES:
        raise invalid(f"单批最多导入 {MAX_MESSAGES} 条消息。")

    imported_conversations = 0
    imported_messages = 0
    updated = 0
    skipped = 0
    failed: list[dict[str, str]] = []

    # Same lock and transaction as imports: deletion wins in either arrival order.
    await _delete_conversations(db, user_id, payload.chat.deletedConversationIds)
    await _import_settings(db, user_id, payload)

    seen_ids: set[str] = set()
    for item in conversations:
        raw_client_id = item.id
        try:
            client_id = validate_client_id(raw_client_id)
        except Exception:  # noqa: BLE001
            failed.append({"clientId": raw_client_id, "reason": "对话标识不合法"})
            continue

        if await db.get(ConversationDeletion, (user_id, client_id)) is not None:
            skipped += 1
            continue

        messages: list[tuple[ImportMessage, str | None]] = []
        for message in item.messages:
            message_client_id = _message_client_id(message.id)
            if message_client_id is not None:
                if message_client_id in seen_ids:
                    message_client_id = None
                else:
                    seen_ids.add(message_client_id)
            messages.append((message, message_client_id))

        existing = (
            await db.execute(
                select(Conversation).where(
                    Conversation.user_id == user_id, Conversation.client_id == client_id
                )
            )
        ).scalar_one_or_none()

        try:
            async with db.begin_nested():
                if existing is None:
                    imported_messages += await _create_conversation(
                        db, user_id, client_id, item, messages
                    )
                    imported_conversations += 1
                else:
                    added, changed = await _merge_conversation(db, user_id, existing, item, messages)
                    if changed:
                        updated += 1
                    else:
                        skipped += 1
                    imported_messages += added
                await db.flush()
        except (SQLAlchemyError, ValueError):
            logger.warning("Import failed for conversation %s", raw_client_id, exc_info=True)
            failed.append({"clientId": raw_client_id, "reason": "写入失败"})

    await db.commit()
    return {
        "imported": {"conversations": imported_conversations, "messages": imported_messages},
        "updated": updated,
        "skipped": skipped,
        "failed": failed,
    }
