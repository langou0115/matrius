"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-10-20
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NOW = sa.text("now()")


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("is_admin", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("must_change_password", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("disabled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("uq_users_username_lower", "users", [sa.text("lower(username)")], unique=True)

    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("scope", sa.String(length=16), server_default="user", nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])
    op.create_index("ix_auth_sessions_expires_at", "auth_sessions", ["expires_at"])

    op.create_table(
        "conversations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.String(length=128), nullable=True),
        sa.Column("title", sa.String(length=500), server_default="", nullable=False),
        sa.Column("pinned", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("model_id", sa.String(length=200), nullable=True),
        sa.Column("title_source", sa.String(length=16), nullable=True),
        sa.Column("client_updated_at_ms", sa.BigInteger(), nullable=True),
        sa.Column("completed_state", sa.String(length=16), server_default="absent", nullable=False),
        sa.Column("completed_read_at_ms", sa.BigInteger(), nullable=True),
        sa.Column("error_state", sa.String(length=16), server_default="absent", nullable=False),
        sa.Column("error_read_at_ms", sa.BigInteger(), nullable=True),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.CheckConstraint(
            "title_source IS NULL OR title_source IN ('auto','ai','manual')",
            name="ck_conversations_title_source",
        ),
        sa.CheckConstraint(
            "completed_state IN ('absent','unread','read')", name="ck_conversations_completed_state"
        ),
        sa.CheckConstraint("error_state IN ('absent','unread','read')", name="ck_conversations_error_state"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "client_id", name="uq_conversations_user_client"),
    )
    op.create_index(
        "ix_conversations_user_order", "conversations", ["user_id", "pinned", "updated_at"]
    )

    op.create_table(
        "messages",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.String(length=128), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("content", sa.Text(), server_default="", nullable=False),
        sa.Column("quote", sa.Text(), nullable=True),
        sa.Column("feedback", sa.String(length=8), nullable=True),
        sa.Column("reasoning", sa.Text(), nullable=True),
        sa.Column("thinking_ms", sa.BigInteger(), nullable=True),
        sa.Column("status", sa.String(length=16), server_default="complete", nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("file_ids", sa.JSON(), server_default=sa.text("'[]'"), nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.CheckConstraint("role IN ('user','assistant')", name="ck_messages_role"),
        sa.CheckConstraint("status IN ('complete','stopped','error')", name="ck_messages_status"),
        sa.CheckConstraint("feedback IS NULL OR feedback IN ('good','bad')", name="ck_messages_feedback"),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "client_id", name="uq_messages_user_client"),
        sa.UniqueConstraint("conversation_id", "position", name="uq_messages_conversation_position"),
    )
    op.create_index("ix_messages_conversation_position", "messages", ["conversation_id", "position"])

    op.create_table(
        "memory_entries",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.String(length=128), nullable=True),
        sa.Column("scope", sa.String(length=16), server_default="global", nullable=False),
        sa.Column("type", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="active", nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("source", sa.String(length=16), server_default="manual", nullable=False),
        sa.Column("client_created_at_ms", sa.BigInteger(), nullable=True),
        sa.Column("client_updated_at_ms", sa.BigInteger(), nullable=True),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.CheckConstraint("scope IN ('global','conversation')", name="ck_memory_entries_scope"),
        sa.CheckConstraint(
            "type IN ('identity','workflow','voice','instruction')", name="ck_memory_entries_type"
        ),
        sa.CheckConstraint("status IN ('active','archived')", name="ck_memory_entries_status"),
        sa.CheckConstraint("source IN ('manual','tool','extracted')", name="ck_memory_entries_source"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "client_id", name="uq_memory_entries_user_client"),
    )
    op.create_index("ix_memory_entries_user_updated", "memory_entries", ["user_id", "updated_at"])

    op.create_table(
        "user_profile_fields",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("value", sa.Text(), server_default="", nullable=False),
        sa.Column("source", sa.String(length=32), server_default="manual", nullable=False),
        sa.Column("client_updated_at_ms", sa.BigInteger(), nullable=True),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "key", name="uq_user_profile_fields_user_key"),
    )

    op.create_table(
        "user_profiles",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("custom_instructions", sa.Text(), server_default="", nullable=False),
        sa.Column("about_name", sa.String(length=100), server_default="", nullable=False),
        sa.Column("occupation", sa.String(length=100), server_default="", nullable=False),
        sa.Column("about_more", sa.Text(), server_default="", nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id"),
    )

    op.create_table(
        "user_preferences",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("theme_id", sa.String(length=64), server_default="twitter", nullable=False),
        sa.Column("mode", sa.String(length=16), server_default="system", nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id"),
    )

    op.create_table(
        "files",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.String(length=128), nullable=True),
        sa.Column("conversation_id", sa.Uuid(), nullable=True),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("object_key", sa.String(length=512), nullable=False),
        sa.Column("content_type", sa.String(length=255), nullable=False),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="ready", nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("object_key"),
        sa.UniqueConstraint("user_id", "client_id", name="uq_files_user_client"),
    )
    op.create_index("ix_files_user_created", "files", ["user_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_files_user_created", table_name="files")
    op.drop_table("files")
    op.drop_table("user_preferences")
    op.drop_table("user_profiles")
    op.drop_table("user_profile_fields")
    op.drop_index("ix_memory_entries_user_updated", table_name="memory_entries")
    op.drop_table("memory_entries")
    op.drop_index("ix_messages_conversation_position", table_name="messages")
    op.drop_table("messages")
    op.drop_index("ix_conversations_user_order", table_name="conversations")
    op.drop_table("conversations")
    op.drop_index("ix_auth_sessions_expires_at", table_name="auth_sessions")
    op.drop_index("ix_auth_sessions_user_id", table_name="auth_sessions")
    op.drop_table("auth_sessions")
    op.drop_index("uq_users_username_lower", table_name="users")
    op.drop_table("users")
