"""Persist conversation deletion identities to prevent stale sync resurrection."""

import sqlalchemy as sa

from alembic import op

revision = "0002_conversation_deletions"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "conversation_deletions",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.String(128), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "client_id"),
    )


def downgrade() -> None:
    op.drop_table("conversation_deletions")
