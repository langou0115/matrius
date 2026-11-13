// Dev-only helper: snapshot the current SQLite schema into a baseline migration.
//
// Usage: node server/scripts/dump-schema.mjs <database> <output.sql>
//
// The TypeScript migration runner owns `alembic_version`, so this script excludes that
// table from the snapshot. Keep the dumped SQL byte-for-byte compatible with what
// Alembic created: UUIDs are CHAR(32) hex strings and timestamps are naive UTC text.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: node server/scripts/dump-schema.mjs <database> <output.sql>');
  process.exit(2);
}

const database = new DatabaseSync(resolve(input), { readOnly: true });
try {
  const rows = database
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name <> 'alembic_version'`,
    )
    .all();
  const tables = rows.filter((row) => row.type === 'table').sort((a, b) => a.name.localeCompare(b.name));
  const indexes = rows.filter((row) => row.type === 'index').sort((a, b) => a.name.localeCompare(b.name));
  const lines = [
    '-- Baseline schema for the single-user Matrius instance.',
    '-- Generated from the Alembic 0001_initial database; do not edit after it has shipped.',
    '',
    ...tables.map((row) => `${row.sql};`),
    '',
    ...indexes.map((row) => `${row.sql};`),
    '',
  ];
  writeFileSync(resolve(output), lines.join('\n'), 'utf8');
  console.log(`Wrote ${tables.length} tables and ${indexes.length} indexes to ${resolve(output)}.`);
} finally {
  database.close();
}
