"""persist the client's rolling context summary with each conversation

Revision ID: 0005_conversation_context_summary
Revises: 0004_auth_session_no_expiry
Create Date: 2026-10-28
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0005_conversation_context_summary"
down_revision: str | None = "0004_auth_session_no_expiry"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Derived context only: existing rows stay NULL and are recompacted by the client.
    op.add_column("conversations", sa.Column("context_summary", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("conversations") as batch:
        batch.drop_column("context_summary")
