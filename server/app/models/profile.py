import uuid

from sqlalchemy import BigInteger, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, RevisionMixin, TimestampMixin


class ProfileField(RevisionMixin, TimestampMixin, Base):
    __tablename__ = "profile_fields"
    __table_args__ = (UniqueConstraint("instance_id", "key", name="uq_profile_fields_instance_key"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    instance_id: Mapped[int] = mapped_column(ForeignKey("instance.id", ondelete="CASCADE"), nullable=False)
    key: Mapped[str] = mapped_column(String(64), nullable=False)
    value: Mapped[str] = mapped_column(Text, default="", nullable=False)
    source: Mapped[str] = mapped_column(String(32), default="manual", nullable=False)
    client_updated_at_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)


class Profile(RevisionMixin, TimestampMixin, Base):
    __tablename__ = "profiles"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    instance_id: Mapped[int] = mapped_column(
        ForeignKey("instance.id", ondelete="CASCADE"), unique=True, nullable=False
    )
    custom_instructions: Mapped[str] = mapped_column(Text, default="", nullable=False)
    about_name: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    occupation: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    about_more: Mapped[str] = mapped_column(Text, default="", nullable=False)


class Preference(RevisionMixin, TimestampMixin, Base):
    __tablename__ = "preferences"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    instance_id: Mapped[int] = mapped_column(
        ForeignKey("instance.id", ondelete="CASCADE"), unique=True, nullable=False
    )
    theme_id: Mapped[str] = mapped_column(String(64), default="twitter", nullable=False)
    mode: Mapped[str] = mapped_column(String(16), default="system", nullable=False)
