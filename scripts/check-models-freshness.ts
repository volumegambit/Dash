#!/usr/bin/env npx tsx
/**
 * CI/lint freshness gate for the bundled provider catalogs.
 *
 * Reads `reviewedAt` from every catalog in
 * apps/gateway/plugins/dash-core-providers/providers/ and gates on the
 * OLDEST one (a catalog nobody re-reviewed is exactly the rot this guards):
 *   0–29 days: silent pass · 30–59: warn · ≥60: hard fail.
 * Refresh with `/update-models` (npm run models:audit:apply), which rewrites
 * the catalog JSONs and bumps each audited catalog's reviewedAt.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WARN_DAYS = 30;
const FAIL_DAYS = 60;
const CATALOG_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../apps/gateway/plugins/dash-core-providers/providers',
);

const files = readdirSync(CATALOG_DIR).filter((f) => f.endsWith('.json'));
if (files.length === 0) {
  console.error(`❌ no provider catalogs found under ${CATALOG_DIR}`);
  process.exit(1);
}

let oldest: { file: string; date: Date } | null = null;
for (const file of files) {
  const parsed = JSON.parse(readFileSync(join(CATALOG_DIR, file), 'utf-8')) as {
    reviewedAt?: string;
  };
  const date = new Date(parsed.reviewedAt ?? Number.NaN);
  if (Number.isNaN(date.getTime())) {
    console.error(`❌ ${file}: reviewedAt missing or not a valid ISO date`);
    process.exit(1);
  }
  if (!oldest || date < oldest.date) oldest = { file, date };
}

const ageDays = Math.floor((Date.now() - (oldest?.date.getTime() ?? 0)) / 86_400_000);
if (ageDays >= FAIL_DAYS) {
  console.error(
    `❌ oldest catalog reviewedAt (${oldest?.file}) is ${ageDays} days old (limit ${FAIL_DAYS}).`,
  );
  console.error(
    '   Run `/update-models` (npm run models:audit:apply) and commit the catalog changes.',
  );
  process.exit(1);
}
if (ageDays >= WARN_DAYS) {
  console.warn(
    `⚠ oldest catalog reviewedAt (${oldest?.file}) is ${ageDays} days old (warn ${WARN_DAYS}, fail ${FAIL_DAYS}).`,
  );
}
process.exit(0);
