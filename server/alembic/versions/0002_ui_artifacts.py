"""Persist generated UI snapshots with messages."""

import sqlalchemy as sa

from alembic import op

revision = "0002_ui_artifacts"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("ui_artifacts", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("messages") as batch:
        batch.drop_column("ui_artifacts")
