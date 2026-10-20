import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.account.schemas import ImportRequest
from app.errors import invalid
from app.models import Conversation, Message, UserPreference, UserProfile
from app.utils import utcnow, validate_client_id

logger = logging.getLogger(__name__)

MAX_CONVERSATIONS = 20
MAX_MESSAGES = 2000
MAX_IMPORT_BYTES = 8 * 1024 * 1024


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


async def _import_settings(db: AsyncSession, user_id: uuid.UUID, payload: ImportRequest) -> None:
    if payload.appearance is not None:
        existing = (
            await db.execute(select(UserPreference.id).where(UserPreference.user_id == user_id))
        ).scalar_one_or_none()
        if existing is None:
            db.add(
                UserPreference(
                    user_id=user_id,
                    theme_id=payload.appearance.themeId,
                    mode=payload.appearance.mode,
                )
            )

    if payload.personalization is not None:
        existing = (
            await db.execute(select(UserProfile.id).where(UserProfile.user_id == user_id))
        ).scalar_one_or_none()
        if existing is None:
            db.add(
                UserProfile(
                    user_id=user_id,
                    custom_instructions=payload.personalization.customInstructions,
                    about_name=payload.personalization.aboutName,
                    occupation=payload.personalization.occupation,
                    about_more=payload.personalization.aboutMore,
                )
            )


async def run_import(db: AsyncSession, user_id: uuid.UUID, payload: ImportRequest) -> dict[str, Any]:
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
    skipped = 0
    failed: list[dict[str, str]] = []

    await _import_settings(db, user_id, payload)

    seen_ids: set[str] = set()
    for item in conversations:
        raw_client_id = item.id
        try:
            client_id = validate_client_id(raw_client_id)
        except Exception:  # noqa: BLE001
            failed.append({"clientId": raw_client_id, "reason": "对话标识不合法"})
            continue

        existing = (
            await db.execute(
                select(Conversation.id).where(
                    Conversation.user_id == user_id, Conversation.client_id == client_id
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            skipped += 1
            continue

        try:
            async with db.begin_nested():
                conversation = Conversation(
                    user_id=user_id,
                    client_id=client_id,
                    title=item.title,
                    pinned=item.pinned,
                    model_id=item.modelId,
                    title_source=item.titleSource,
                    client_updated_at_ms=item.updatedAt,
                    updated_at=_client_time(item.updatedAt),
                )
                db.add(conversation)
                await db.flush()

                for index, message in enumerate(item.messages, start=1):
                    message_client_id = _message_client_id(message.id)
                    if message_client_id is not None:
                        if message_client_id in seen_ids:
                            message_client_id = None
                        else:
                            seen_ids.add(message_client_id)
                    db.add(
                        Message(
                            user_id=user_id,
                            conversation_id=conversation.id,
                            client_id=message_client_id,
                            position=index,
                            role=message.role,
                            content=message.content,
                            quote=message.quote,
                            feedback=message.feedback,
                            reasoning=message.reasoning,
                            thinking_ms=message.thinkingMs,
                            status="complete" if message.role == "user" else message.status,
                            error=message.error,
                        )
                    )
                await db.flush()

            imported_conversations += 1
            imported_messages += len(item.messages)
        except (SQLAlchemyError, ValueError):
            logger.warning("Import failed for conversation %s", raw_client_id, exc_info=True)
            failed.append({"clientId": raw_client_id, "reason": "写入失败"})

    await db.commit()
    return {
        "imported": {"conversations": imported_conversations, "messages": imported_messages},
        "skipped": skipped,
        "failed": failed,
    }
