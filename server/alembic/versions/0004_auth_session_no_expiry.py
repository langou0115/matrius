"""Keep auth sessions valid until logout or revocation."""

import sqlalchemy as sa

from alembic import op

revision = "0004_auth_session_no_expiry"
down_revision = "0003_message_steering"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Relax the constraint first, then make existing sessions permanent too. The cookie
    # still expires at the browser cap and can be slid forward by /me.
    with op.batch_alter_table("auth_sessions") as batch:
        batch.alter_column(
            "expires_at", existing_type=sa.DateTime(timezone=True), nullable=True
        )
    op.execute("UPDATE auth_sessions SET expires_at = NULL")


def downgrade() -> None:
    op.execute(
        "UPDATE auth_sessions SET expires_at = datetime('now', '+7 days') "
        "WHERE expires_at IS NULL"
    )
    with op.batch_alter_table("auth_sessions") as batch:
        batch.alter_column(
            "expires_at", existing_type=sa.DateTime(timezone=True), nullable=False
        )
