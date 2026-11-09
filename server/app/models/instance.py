from sqlalchemy import CheckConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Instance(Base):
    __tablename__ = "instance"
    __table_args__ = (CheckConstraint("id = 1", name="ck_instance_singleton"),)

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
