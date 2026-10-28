"""Persist the web tool steps shown in a reply's reasoning panel."""

import sqlalchemy as sa

from alembic import op

revision = "0006_message_activities"
down_revision = "0005_conversation_context_summary"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Local-only `process` stays out of the database; the client rebuilds it from
    # `reasoning` plus these entries.
    op.add_column("messages", sa.Column("activities", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("messages") as batch:
        batch.drop_column("activities")
