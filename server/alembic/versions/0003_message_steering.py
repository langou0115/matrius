"""Mark user supplements injected into an in-flight reply."""

import sqlalchemy as sa

from alembic import op

revision = "0003_message_steering"
down_revision = "0002_conversation_deletions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("steering", sa.Boolean(), server_default=sa.text("0"), nullable=False),
    )


def downgrade() -> None:
    op.drop_column("messages", "steering")
