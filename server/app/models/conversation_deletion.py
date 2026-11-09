
from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ConversationDeletion(Base):
    """Retain only identity, never deleted conversation content."""

    __tablename__ = "conversation_deletions"

    instance_id: Mapped[int] = mapped_column(
        ForeignKey("instance.id", ondelete="CASCADE"), primary_key=True
    )
    client_id: Mapped[str] = mapped_column(String(128), primary_key=True)
