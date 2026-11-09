import uuid
from datetime import date

from sqlalchemy import BigInteger, Date, ForeignKey, Integer, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class TokenUsageDaily(TimestampMixin, Base):
    """One row per instance and calendar day.

    The browser reports the token usage of each finished reply because the model request never
    reaches the API: it is relayed through the stateless Web container. The client also decides
    which local day a reply belongs to, so the panel matches the reader's calendar instead of
    the server's UTC day. Tokens are cumulative counters, never per-message detail.
    """

    __tablename__ = "token_usage_daily"
    __table_args__ = (
        UniqueConstraint("instance_id", "day", name="uq_token_usage_daily_instance_day"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    instance_id: Mapped[int] = mapped_column(
        ForeignKey("instance.id", ondelete="CASCADE"), nullable=False
    )
    day: Mapped[date] = mapped_column(Date, nullable=False)
    input_tokens: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    cache_read_tokens: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    cache_write_tokens: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    # One report per replied run, including runs that made several model/tool rounds.
    requests: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class TokenUsageEstimateDaily(TimestampMixin, Base):
    """Backfilled estimate for conversations that predate usage recording.

    Real provider usage never reached the API, so history can only be estimated from stored
    message text. Estimates live in their own table so reported usage is never mixed with
    approximations and so a re-run can replace them atomically.
    """

    __tablename__ = "token_usage_estimate_daily"
    __table_args__ = (
        UniqueConstraint("instance_id", "day", name="uq_token_usage_estimate_daily_instance_day"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    instance_id: Mapped[int] = mapped_column(
        ForeignKey("instance.id", ondelete="CASCADE"), nullable=False
    )
    day: Mapped[date] = mapped_column(Date, nullable=False)
    input_tokens: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    requests: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class UsageBackfill(TimestampMixin, Base):
    """Marks that history was estimated once for an instance, including empty histories."""

    __tablename__ = "usage_backfills"

    instance_id: Mapped[int] = mapped_column(
        ForeignKey("instance.id", ondelete="CASCADE"), primary_key=True
    )
