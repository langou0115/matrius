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
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, RevisionMixin, TimestampMixin
from app.utils import utcnow


class Message(RevisionMixin, TimestampMixin, Base):
    __tablename__ = "messages"
    __table_args__ = (
        UniqueConstraint("instance_id", "client_id", name="uq_messages_instance_client"),
        UniqueConstraint("conversation_id", "position", name="uq_messages_conversation_position"),
        Index("ix_messages_conversation_position", "conversation_id", "position"),
        CheckConstraint("role IN ('user','assistant')", name="ck_messages_role"),
        CheckConstraint("status IN ('complete','stopped','error')", name="ck_messages_status"),
        CheckConstraint("feedback IS NULL OR feedback IN ('good','bad')", name="ck_messages_feedback"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    instance_id: Mapped[int] = mapped_column(ForeignKey("instance.id", ondelete="CASCADE"), nullable=False)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    client_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    content: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # User supplement sent while the preceding reply was still streaming.
    steering: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    quote: Mapped[str | None] = mapped_column(Text, nullable=True)
    feedback: Mapped[str | None] = mapped_column(String(8), nullable=True)
    reasoning: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Web search/fetch/file steps for this reply, compacted for display.
    activities: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, nullable=True)
    # Full ordered process: thinking segments and tool calls interleaved, as they happened.
    process: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, nullable=True)
    ui_artifacts: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, nullable=True)
    thinking_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="complete", nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    file_ids: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
