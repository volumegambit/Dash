import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database as DatabaseType } from 'better-sqlite3';

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));

interface Migration {
  version: number;
  file: string;
}

/**
 * Numbered `.sql` migrations, applied in ascending version order. Each
 * unapplied migration runs inside its own transaction together with the
 * `INSERT INTO schema_version` row, so a failed migration rolls back
 * cleanly and never half-applies. Re-running is a no-op once the version
 * is recorded.
 *
 * Add a migration by dropping `NNN_name.sql` next to this file and
 * appending it to `MIGRATIONS` with its numeric version.
 */
const MIGRATIONS: Migration[] = [{ version: 1, file: '001_init.sql' }];

function schemaVersionTableExists(db: DatabaseType): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get() as { name: string } | undefined;
  return row !== undefined;
}

function appliedVersions(db: DatabaseType): Set<number> {
  if (!schemaVersionTableExists(db)) return new Set();
  const rows = db.prepare('SELECT version FROM schema_version').all() as { version: number }[];
  return new Set(rows.map((r) => r.version));
}

export function runMigrations(db: DatabaseType): void {
  const applied = appliedVersions(db);

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, migration.file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      // Migration 001 creates the schema_version table itself, so on the
      // first run the version row is inserted into a table the same SQL just
      // made; INSERT OR IGNORE guards that special case (and keeps every later
      // migration uniform). Do not replace it with a plain INSERT.
      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(
        migration.version,
      );
    });
    apply();
  }
}
