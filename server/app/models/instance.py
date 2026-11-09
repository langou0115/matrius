"""The singleton binding between this deployment and its owner.

Legacy users and ownership foreign keys remain readable for migration/backup only.
Only the owner referenced here can authenticate or access the instance.
"""

import uuid

from sqlalchemy import CheckConstraint, ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Instance(Base):
    __tablename__ = "instance"
    __table_args__ = (CheckConstraint("id = 1", name="ck_instance_singleton"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id"), nullable=False, unique=True
    )
