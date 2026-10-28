import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, RevisionMixin, TimestampMixin
from app.utils import utcnow


class Conversation(RevisionMixin, TimestampMixin, Base):
    __tablename__ = "conversations"
    __table_args__ = (
        UniqueConstraint("user_id", "client_id", name="uq_conversations_user_client"),
        Index("ix_conversations_user_order", "user_id", "pinned", "updated_at"),
        CheckConstraint(
            "title_source IS NULL OR title_source IN ('auto','ai','manual')",
            name="ck_conversations_title_source",
        ),
        CheckConstraint("completed_state IN ('absent','unread','read')", name="ck_conversations_completed_state"),
        CheckConstraint("error_state IN ('absent','unread','read')", name="ck_conversations_error_state"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    client_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    title: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    pinned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    model_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    title_source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Client-generated rolling summary: {coveredUntilMessageId, summary}. It is derived
    # context, so a missing or stale value only costs one extra compaction request.
    context_summary: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    client_updated_at_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    completed_state: Mapped[str] = mapped_column(String(16), default="absent", nullable=False)
    completed_read_at_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    error_state: Mapped[str] = mapped_column(String(16), default="absent", nullable=False)
    error_read_at_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
