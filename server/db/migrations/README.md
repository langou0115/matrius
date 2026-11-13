# Migrations

The TypeScript server keeps the `alembic_version` table and uses the same
revision ids as Alembic. This is deliberate:

- existing production/development databases are adopted, not rebuilt;
- a rollback to the Python server still sees a known revision;
- backups remain interchangeable.

## Rules

1. Never edit a migration after it has shipped. Add a new file and a new entry in
   `server/db/migrate.ts`.
2. `0001_initial.sql` is the baseline generated from the Alembic
   `0001_initial` schema. It is the exact schema the Python server created.
3. New migrations are plain SQL. SQLite has limited `ALTER TABLE`; rebuild tables
   explicitly when needed and test on a copy of the real database.
4. Test both paths:
   - empty database -> baseline -> head;
   - database already at `0001_initial` -> only new revisions run.
5. Keep `alembic_version` as the only revision table. Do not add a second
   migration journal unless the project explicitly decides to abandon Python
   compatibility.

`server/scripts/dump-schema.mjs` snapshots an existing SQLite schema into a
baseline file for review; do not run it as part of normal startup.
