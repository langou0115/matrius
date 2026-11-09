"""Remove credentials and replace account ownership with singleton instance scope."""

import sqlite3
import time
from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision = "0011_remove_accounts"
down_revision = "0010_single_user_instance"
branch_labels = None
depends_on = None

TABLES = (
    "conversations",
    "messages",
    "files",
    "memory_entries",
    "conversation_deletions",
    "user_preferences",
    "user_profiles",
    "user_profile_fields",
    "token_usage_daily",
    "token_usage_estimate_daily",
    "usage_backfills",
)
RENAMES = {
    "user_preferences": "preferences",
    "user_profiles": "profiles",
    "user_profile_fields": "profile_fields",
}


def _prepare_legacy_data(connection) -> None:
    """Archive the original database before resolving formerly account-scoped keys."""
    databases = connection.execute(sa.text("PRAGMA database_list")).all()
    database = next((row[2] for row in databases if row[1] == "main"), "")
    if database:
        source_path = Path(database).resolve()
        backup_path = source_path.with_name(f"{source_path.stem}.before-account-removal-{time.time_ns()}.db")
        with sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True) as source:
            with sqlite3.connect(backup_path) as target:
                source.backup(target)

    owner = connection.execute(sa.text("SELECT owner_id FROM instance WHERE id = 1")).scalar_one_or_none()
    for table in TABLES:
        rows = [dict(row) for row in connection.execute(sa.text(f'SELECT * FROM "{table}"')).mappings()]
        if not rows:
            continue
        if table in ("user_preferences", "user_profiles", "usage_backfills"):
            keys = []
        elif table == "user_profile_fields":
            keys = ["key"]
        elif table in ("token_usage_daily", "token_usage_estimate_daily"):
            keys = ["day"]
        else:
            keys = ["client_id"]
        groups = {}
        for row in rows:
            key = tuple(row[k] for k in keys)
            if any(value is None for value in key):
                continue
            groups.setdefault(key, []).append(row)
        for duplicates in groups.values():
            if len(duplicates) < 2:
                continue
            duplicates.sort(key=lambda row: (row["user_id"] == owner, str(row.get("updated_at", "")),
                                              str(row.get("id", row["user_id"]))), reverse=True)
            keep = duplicates[0]
            if table in ("token_usage_daily", "token_usage_estimate_daily"):
                counters = [key for key in keep if key.endswith("_tokens") or key == "requests"]
                values = {key: sum(row[key] for row in duplicates) for key in counters}
                assignments = ", ".join(f'"{key}" = :{key}' for key in counters)
                connection.execute(sa.text(f'UPDATE "{table}" SET {assignments} WHERE id = :row_id'),
                                   {**values, "row_id": keep["id"]})
            for row in duplicates[1:]:
                if table in ("conversations", "messages", "files", "memory_entries"):
                    # Preserve the resource and its UUID relationships; only the ambiguous
                    # old import key is removed. The original key remains in the backup.
                    connection.execute(sa.text(f'UPDATE "{table}" SET client_id = NULL WHERE id = :id'), row)
                elif "id" in row:
                    connection.execute(sa.text(f'DELETE FROM "{table}" WHERE id = :id'), row)
                else:
                    condition = 'user_id = :user_id'
                    if keys:
                        condition += " AND " + " AND ".join(f'"{key}" = :{key}' for key in keys)
                    connection.execute(sa.text(f'DELETE FROM "{table}" WHERE {condition}'), row)


def upgrade() -> None:
    connection = op.get_bind()
    _prepare_legacy_data(connection)
    inspector = sa.inspect(connection)
    # Refuse ambiguous merges before changing any data. Never discard legacy business rows.
    for table in TABLES:
        for unique in inspector.get_unique_constraints(table):
            columns = [c for c in unique["column_names"] if c != "user_id"]
            if "user_id" not in unique["column_names"]:
                continue
            if columns:
                fields = ", ".join(f'"{c}"' for c in columns)
                condition = " AND ".join(f'"{c}" IS NOT NULL' for c in columns)
                query = f'SELECT 1 FROM "{table}" WHERE {condition} GROUP BY {fields} HAVING COUNT(*) > 1'
            else:
                query = f'SELECT COUNT(*) FROM "{table}" HAVING COUNT(*) > 1'
            if connection.execute(sa.text(query)).first():
                raise RuntimeError(f"Cannot merge conflicting legacy rows in {table}; export and resolve them first.")
    if connection.execute(sa.text("SELECT COUNT(*) FROM usage_backfills")).scalar_one() > 1:
        raise RuntimeError("Resolve multiple legacy usage backfills before migrating.")

    with op.batch_alter_table("instance") as batch:
        batch.drop_column("owner_id")
    connection.execute(sa.text("INSERT OR IGNORE INTO instance (id) VALUES (1)"))

    for table in TABLES:
        foreign_keys = inspector.get_foreign_keys(table)
        indexes = inspector.get_indexes(table)
        uniques = inspector.get_unique_constraints(table)
        # SQLite migration connections have FK enforcement disabled while tables are rebuilt.
        connection.execute(sa.text(f'UPDATE "{table}" SET user_id = 1'))
        with op.batch_alter_table(table, naming_convention={"fk": "fk_%(table_name)s_%(column_0_name)s"}) as batch:
            for fk in foreign_keys:
                if fk["constrained_columns"] == ["user_id"]:
                    batch.drop_constraint(fk["name"] or f"fk_{table}_user_id", type_="foreignkey")
            for index in indexes:
                if "user_id" in index["column_names"]:
                    batch.drop_index(index["name"])
            for unique in uniques:
                if "user_id" in unique["column_names"] and unique["name"]:
                    batch.drop_constraint(unique["name"], type_="unique")
            batch.alter_column("user_id", new_column_name="instance_id", type_=sa.Integer(), existing_nullable=False)

        for index in indexes:
            if "user_id" in index["column_names"]:
                op.create_index(
                    index["name"].replace("user", "instance"),
                    table,
                    ["instance_id" if c == "user_id" else c for c in index["column_names"]],
                    unique=index["unique"],
                )
        with op.batch_alter_table(table) as batch:
            batch.create_foreign_key(f"fk_{table}_instance_id", "instance", ["instance_id"], ["id"], ondelete="CASCADE")
            for unique in uniques:
                if "user_id" in unique["column_names"] and unique["name"]:
                    batch.create_unique_constraint(
                        unique["name"].replace("user_profile", "profile").replace("user", "instance"),
                        ["instance_id" if c == "user_id" else c for c in unique["column_names"]],
                    )
        if table in RENAMES:
            op.rename_table(table, RENAMES[table])
    op.drop_table("auth_sessions")
    op.drop_table("users")


def downgrade() -> None:
    raise RuntimeError("Account removal is irreversible; restore a pre-migration backup to downgrade.")
