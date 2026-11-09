import uuid

from sqlalchemy import BigInteger, CheckConstraint, ForeignKey, Index, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, RevisionMixin, TimestampMixin


class MemoryEntry(RevisionMixin, TimestampMixin, Base):
    __tablename__ = "memory_entries"
    __table_args__ = (
        UniqueConstraint("instance_id", "client_id", name="uq_memory_entries_instance_client"),
        Index("ix_memory_entries_instance_updated", "instance_id", "updated_at"),
        CheckConstraint("scope IN ('global','conversation')", name="ck_memory_entries_scope"),
        CheckConstraint("type IN ('identity','workflow','voice','instruction')", name="ck_memory_entries_type"),
        CheckConstraint("status IN ('active','archived')", name="ck_memory_entries_status"),
        CheckConstraint("source IN ('manual','tool','extracted')", name="ck_memory_entries_source"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    instance_id: Mapped[int] = mapped_column(ForeignKey("instance.id", ondelete="CASCADE"), nullable=False)
    client_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    scope: Mapped[str] = mapped_column(String(16), default="global", nullable=False)
    type: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="active", nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(String(16), default="manual", nullable=False)
    client_created_at_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    client_updated_at_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
