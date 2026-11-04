"""Persist the full ordered reasoning/tool process for each reply."""

import sqlalchemy as sa

from alembic import op

revision = "0007_message_process"
down_revision = "0006_message_activities"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The ordered process (thinking and tool calls interleaved) is display-only but must survive
    # a reload. `activities` stays as the compacted cross-device summary.
    op.add_column("messages", sa.Column("process", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("messages") as batch:
        batch.drop_column("process")
