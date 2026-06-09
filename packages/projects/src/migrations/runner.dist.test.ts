import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Regression test for the bundled/flattened layout.
 *
 * The plain unit tests import `runMigrations` from SOURCE, where `runner.ts`
 * happens to sit in `src/migrations/` right next to `001_init.sql`, so the
 * `import.meta.url`-relative path is coincidentally correct. tsup, however,
 * flattens the whole package into `dist/index.js`: at runtime `import.meta.url`
 * is `dist/index.js`, so a naive `dirname(...)` would look for
 * `dist/001_init.sql` while the `onSuccess` hook copies the SQL to
 * `dist/migrations/`. That mismatch is an ENOENT the moment the gateway loads
 * the BUILT package — a crash the source-importing tests can never see.
 *
 * This test builds the package and exercises the *built* `dist/index.js`
 * through `openProjectsDb`, asserting it does not throw ENOENT and that the
 * migration actually created the schema. It WOULD have caught the original
 * bug (it fails with `ENOENT ... dist/001_init.sql` against the naive runner).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..', '..');
const DIST_ENTRY = join(PKG_ROOT, 'dist', 'index.js');

describe('runMigrations (bundled dist layout)', () => {
  let tmpDir: string;

  beforeAll(() => {
    // Build the package so the bundled artifact + copied .sql exist. Skip the
    // build if dist is already present to keep the common case fast; CI's build
    // step also produces it.
    if (!existsSync(DIST_ENTRY)) {
      execFileSync('npm', ['run', 'build'], { cwd: PKG_ROOT, stdio: 'inherit' });
    }
    tmpDir = mkdtempSync(join(tmpdir(), 'projects-dist-'));
  }, 120_000);

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves the .sql from the built bundle and creates the schema', async () => {
    // Import the BUILT package, not source — this is the whole point.
    const mod = (await import(DIST_ENTRY)) as typeof import('../index.js');
    const projects = mod.openProjectsDb(tmpDir);
    try {
      const tables = (
        projects.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      for (const t of ['project', 'issue', 'issue_comment', 'schema_version']) {
        expect(tables).toContain(t);
      }
    } finally {
      projects.db.close();
    }
  });
});
