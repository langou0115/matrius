"""Track per-account daily token usage for the storage usage panel."""

import sqlalchemy as sa

from alembic import op

revision = "0008_token_usage_daily"
down_revision = "0007_message_process"
branch_labels = None
depends_on = None

NOW = sa.text("CURRENT_TIMESTAMP")


def upgrade() -> None:
    # One row per account and local calendar day. The browser reports reply usage because the
    # model request goes through the stateless Web relay, not the API process.
    op.create_table(
        "token_usage_daily",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("input_tokens", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("output_tokens", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("cache_read_tokens", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("cache_write_tokens", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("requests", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "day", name="uq_token_usage_daily_user_day"),
    )


def downgrade() -> None:
    op.drop_table("token_usage_daily")
