"""Bind each deployment to one owner without deleting historical data."""

import sqlalchemy as sa

from alembic import op
import os

revision = "0010_single_user_instance"
down_revision = "0009_token_usage_estimate"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    users = connection.execute(sa.text("SELECT id, username FROM users")).all()
    configured = os.environ.get("INITIAL_ADMIN_USERNAME", "").strip().lower()
    matches = [row for row in users if row.username.lower() == configured]
    if len(users) > 1 and not matches:
        raise RuntimeError(
            "Legacy database has multiple users. Set INITIAL_ADMIN_USERNAME to the "
            "existing account that will own this instance, then retry migration. "
            "Other accounts and their data will be preserved but inaccessible."
        )
    owner = matches[0] if matches else users[0] if users else None
    op.create_table(
        "instance",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.CheckConstraint("id = 1", name="ck_instance_singleton"),
        sa.UniqueConstraint("owner_id"),
    )
    if owner:
        # Preserve UUID representation in the existing database.
        connection.execute(
            sa.text("INSERT INTO instance (id, owner_id) VALUES (1, :owner)"),
            {"owner": owner.id},
        )
    # All pre-migration sessions are invalidated, including old administrator cookies.
    connection.execute(sa.text("UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP"))
    with op.batch_alter_table("users") as batch:
        batch.drop_column("is_admin")
        batch.drop_column("disabled_at")


def downgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("is_admin", sa.Boolean(), server_default=sa.false(), nullable=False))
        batch.add_column(sa.Column("disabled_at", sa.DateTime(timezone=True), nullable=True))
    op.drop_table("instance")
