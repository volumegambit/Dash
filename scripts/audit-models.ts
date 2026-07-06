#!/usr/bin/env npx tsx
/**
 * Audit script for the bundled provider catalogs in
 * apps/gateway/plugins/dash-core-providers/providers/.
 *
 * What it does:
 *   1. Loads provider credentials from process.env (then .env.local at
 *      repo root via a tiny inline parser).
 *   2. For each catalog JSON with a credential, fetches its live /models
 *      list via the same declarative fetcher the gateway uses
 *      (`fetchCatalogModels`).
 *   3. Diffs the live response against the catalog:
 *        - newUnmatched  = live ids matching no supportedPattern (findCatalogPattern → null)
 *        - staleStatics  = catalog.models ids no longer present in the live list
 *        - name drift    = still-live static models whose live label differs from models[].name
 *   4. Prints a human-readable report (or --json for machine output).
 *   5. With --apply, walks each credentialed catalog interactively:
 *        - refreshes names of still-live static models from the live label,
 *        - DROPS static models no longer live,
 *        - does NOT auto-add unmatched ids (curation stays human — prints them),
 *        - bumps that catalog's reviewedAt to today on every audited catalog
 *          (even when unchanged — reviewedAt means "a human looked"),
 *        - writes the JSON back deterministically,
 *      then runs `npm test` + `npm run models:check` and prints the git diff.
 *
 * Usage:
 *   npm run models:audit                   # read-only report
 *   npm run models:audit -- --json         # machine-readable output
 *   npm run models:audit:apply             # interactive update mode
 *
 * Credentials:
 *   The script looks for ANTHROPIC_API_KEY / OPENAI_API_KEY /
 *   GOOGLE_API_KEY / MOONSHOT_API_KEY / OPENROUTER_API_KEY in process.env
 *   first. If not found, loads from .env.local at the repo root. Missing
 *   credentials = catalog is skipped (reported as such, not audited).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import type { ProviderCatalog } from '@dash/plugin-sdk';
// Use fetchCatalogModels directly (NOT discoverCatalogModels — the audit needs
// per-catalog raw ids to report unmatched models, which discover filters out).
import {
  fetchCatalogModels,
  findCatalogPattern,
  globToRegex,
  validateProviderCatalog,
} from '@dash/plugins';
import { localDateStamp } from './local-date.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CATALOG_DIR = join(REPO_ROOT, 'apps/gateway/plugins/dash-core-providers/providers');

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const apply = args.includes('--apply');

// ---------------------------------------------------------------------------
// Credential loading
// ---------------------------------------------------------------------------

function loadEnvLocal(): Record<string, string> {
  const envPath = join(REPO_ROOT, '.env.local');
  if (!existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  const text = readFileSync(envPath, 'utf-8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  // Keyed by catalog id — must be 'moonshotai' (matches the catalog id).
  moonshotai: 'MOONSHOT_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

function resolveCredential(catalogId: string, env: Record<string, string>): string | null {
  const key = ENV_KEYS[catalogId];
  if (!key) return null;
  return process.env[key] || env[key] || null;
}

// ---------------------------------------------------------------------------
// Catalog loading
// ---------------------------------------------------------------------------

interface LoadedCatalog {
  file: string;
  path: string;
  catalog: ProviderCatalog;
}

function loadCatalogs(): LoadedCatalog[] {
  const files = readdirSync(CATALOG_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((file) => {
    const path = join(CATALOG_DIR, file);
    // validateProviderCatalog throws on a malformed catalog — the audit refuses
    // to run against an invalid catalog rather than silently misreport.
    const catalog = validateProviderCatalog(JSON.parse(readFileSync(path, 'utf-8')));
    return { file, path, catalog };
  });
}

// ---------------------------------------------------------------------------
// Discovery + diff
// ---------------------------------------------------------------------------

interface LiveModel {
  id: string;
  label: string;
}

interface DriftEntry {
  id: string;
  current: string;
  live: string;
}

/**
 * True when a live model id matches any of the catalog's `excludedPatterns`
 * globs — mirrors the deny-wins short-circuit in `findCatalogPattern`. Absent
 * pattern list is treated as empty.
 */
function isCatalogExcluded(catalog: ProviderCatalog, modelId: string): boolean {
  for (const pattern of catalog.excludedPatterns ?? []) {
    if (globToRegex(pattern).test(modelId)) return true;
  }
  return false;
}

interface ProviderReport {
  provider: string;
  configured: boolean;
  fetchError?: string;
  liveCount: number;
  /** Live ids matching no supportedPattern (candidate additions — human-curated). */
  unmatched: LiveModel[];
  /**
   * Live ids matched by an `excludedPatterns` glob — intentional deny-list
   * exclusions (non-chat modalities), NOT candidate additions. Bucketed
   * separately so they don't pollute the unmatched list.
   */
  excluded: LiveModel[];
  /** Static catalog models no longer present in the live list (dropped on --apply). */
  staleStatics: string[];
  /** Still-live static models whose name differs from the live label (refreshed on --apply). */
  nameDrift: DriftEntry[];
}

async function gatherReport(catalogs: LoadedCatalog[]): Promise<ProviderReport[]> {
  const env = loadEnvLocal();
  const reports: ProviderReport[] = [];

  for (const { catalog } of catalogs) {
    const apiKey = resolveCredential(catalog.id, env);
    if (!apiKey) {
      reports.push({
        provider: catalog.id,
        configured: false,
        liveCount: 0,
        unmatched: [],
        excluded: [],
        staleStatics: [],
        nameDrift: [],
      });
      continue;
    }

    let live: LiveModel[] = [];
    let fetchError: string | undefined;
    try {
      live = await fetchCatalogModels(catalog, apiKey);
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }

    if (fetchError) {
      reports.push({
        provider: catalog.id,
        configured: true,
        fetchError,
        liveCount: 0,
        unmatched: [],
        excluded: [],
        staleStatics: [],
        nameDrift: [],
      });
      continue;
    }

    const liveById = new Map(live.map((m) => [m.id, m]));
    // Deny-listed ids match no allow pattern after exclusion, so bucket them
    // separately rather than surfacing them as "potential additions" — they are
    // intentionally filtered out (non-chat modalities). `unmatched` is then only
    // the genuinely-new ids a human might want to allow-list.
    const excluded = live.filter((m) => isCatalogExcluded(catalog, m.id));
    const unmatched = live.filter(
      (m) => !isCatalogExcluded(catalog, m.id) && findCatalogPattern(catalog, m.id) === null,
    );
    const staleStatics = catalog.models.filter((m) => !liveById.has(m.id)).map((m) => m.id);
    const nameDrift: DriftEntry[] = [];
    for (const model of catalog.models) {
      const liveModel = liveById.get(model.id);
      if (!liveModel) continue;
      const current = model.name ?? model.id;
      if (liveModel.label !== current) {
        nameDrift.push({ id: model.id, current, live: liveModel.label });
      }
    }

    reports.push({
      provider: catalog.id,
      configured: true,
      liveCount: live.length,
      unmatched,
      excluded,
      staleStatics,
      nameDrift,
    });
  }

  return reports;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printReport(catalogs: LoadedCatalog[], reports: ProviderReport[]): void {
  console.log();
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║               PROVIDER CATALOG AUDIT REPORT                  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log();

  const byId = new Map(catalogs.map((c) => [c.catalog.id, c.catalog]));

  for (const report of reports) {
    const catalog = byId.get(report.provider);
    console.log(`── ${report.provider.toUpperCase()} ──`);
    const reviewedAt = catalog?.reviewedAt;
    if (reviewedAt) {
      const ageDays = Math.floor((Date.now() - new Date(reviewedAt).getTime()) / 86_400_000);
      console.log(`  reviewedAt: ${reviewedAt} (${ageDays} days ago)`);
    }
    if (!report.configured) {
      console.log(
        `  Skipped: no credential (set ${ENV_KEYS[report.provider]} in .env.local or env)`,
      );
      console.log();
      continue;
    }
    if (report.fetchError) {
      console.log(`  Fetch error: ${report.fetchError}`);
      console.log();
      continue;
    }
    console.log(`  Total returned by API: ${report.liveCount}`);
    console.log(`  Static models in catalog: ${catalog?.models.length ?? 0}`);
    console.log(`  Unmatched (no pattern; potential additions): ${report.unmatched.length}`);
    const shown = report.unmatched.slice(0, 20);
    for (const m of shown) {
      console.log(`    • ${m.id.padEnd(40)} ${m.label}`);
    }
    if (report.unmatched.length > shown.length) {
      console.log(`    ... and ${report.unmatched.length - shown.length} more`);
    }
    if (report.excluded.length > 0) {
      console.log(`  Excluded by deny-list (intentional): ${report.excluded.length}`);
      const shownExcluded = report.excluded.slice(0, 20);
      for (const m of shownExcluded) {
        console.log(`    – ${m.id.padEnd(40)} ${m.label}`);
      }
      if (report.excluded.length > shownExcluded.length) {
        console.log(`    ... and ${report.excluded.length - shownExcluded.length} more`);
      }
    }
    if (report.staleStatics.length > 0) {
      console.log(
        `  Static models no longer live (drop on --apply): ${report.staleStatics.length}`,
      );
      for (const id of report.staleStatics) {
        console.log(`    ⚠ ${id}  ← suggest removal`);
      }
    }
    if (report.nameDrift.length > 0) {
      console.log(`  Name drift (refresh on --apply): ${report.nameDrift.length}`);
      for (const d of report.nameDrift) {
        console.log(
          `    ~ ${d.id.padEnd(30)} ${JSON.stringify(d.current)} → ${JSON.stringify(d.live)}`,
        );
      }
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Apply mode (interactive JSON rewrites)
// ---------------------------------------------------------------------------

async function applyChanges(catalogs: LoadedCatalog[], reports: ProviderReport[]): Promise<void> {
  const rl = createInterface({ input, output });
  const ask = async (q: string): Promise<boolean> => {
    const a = await rl.question(`${q} [y/N] `);
    return a.toLowerCase().startsWith('y');
  };

  const env = loadEnvLocal();
  const today = localDateStamp();
  const byId = new Map(reports.map((r) => [r.provider, r]));

  for (const { file, path, catalog } of catalogs) {
    const report = byId.get(catalog.id);
    if (!report || !report.configured || report.fetchError) {
      // Not audited (no credential or fetch failed) — leave untouched.
      continue;
    }

    console.log();
    console.log(`── ${catalog.id.toUpperCase()} (${file}) ──`);

    // Re-fetch live labels for the name refresh + drop set. We already have the
    // diff in the report, but need the live labels keyed by id to refresh names.
    const apiKey = resolveCredential(catalog.id, env);
    let live: LiveModel[] = [];
    if (apiKey) {
      try {
        live = await fetchCatalogModels(catalog, apiKey);
      } catch (err) {
        console.log(`  Re-fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const liveById = new Map(live.map((m) => [m.id, m]));

    if (report.staleStatics.length > 0) {
      console.log(
        `  Will drop ${report.staleStatics.length} stale static model(s): ${report.staleStatics.join(', ')}`,
      );
    }
    if (report.nameDrift.length > 0) {
      console.log(`  Will refresh ${report.nameDrift.length} name(s).`);
    }
    if (report.unmatched.length > 0) {
      console.log(
        `  ${report.unmatched.length} unmatched live id(s) — NOT auto-added (edit supportedPatterns by hand):`,
      );
      for (const m of report.unmatched.slice(0, 10)) {
        console.log(`    ${m.id}`);
      }
    }

    if (!(await ask(`Apply to ${file} (drop stale, refresh names, bump reviewedAt → ${today})?`))) {
      console.log('  Skipped.');
      continue;
    }

    // Keep existing static entries whose id is still live; drop the rest.
    // Refresh each kept entry's name from the live label.
    const nextModels = catalog.models
      .filter((m) => liveById.has(m.id))
      .map((m) => {
        const label = liveById.get(m.id)?.label;
        return label && label !== m.id ? { ...m, name: label } : m;
      });
    const nextCatalog: ProviderCatalog = {
      ...catalog,
      models: nextModels,
      reviewedAt: today,
    };
    writeFileSync(path, `${JSON.stringify(nextCatalog, null, 2)}\n`);
    console.log(`  Wrote ${file} (reviewedAt → ${today}, ${nextModels.length} static models).`);
  }

  console.log();
  console.log('Running tests + freshness check...');
  // execFileSync (not exec) — no shell, no injection surface, hardcoded args.
  try {
    execFileSync('npm', ['test'], { stdio: 'inherit', cwd: REPO_ROOT });
    execFileSync('npm', ['run', 'models:check'], { stdio: 'inherit', cwd: REPO_ROOT });
  } catch {
    console.error('Verification failed. Review the diff and revert if needed.');
  }

  console.log();
  console.log('git diff:');
  try {
    execFileSync('git', ['diff', 'apps/gateway/plugins/dash-core-providers/providers/'], {
      stdio: 'inherit',
      cwd: REPO_ROOT,
    });
  } catch {
    /* git not in this dir */
  }

  rl.close();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const catalogs = loadCatalogs();
  const reports = await gatherReport(catalogs);

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          catalogs: catalogs.map((c) => ({
            id: c.catalog.id,
            reviewedAt: c.catalog.reviewedAt,
            staticModels: c.catalog.models.length,
            supportedPatterns: c.catalog.supportedPatterns?.length ?? 0,
          })),
          providers: reports,
        },
        null,
        2,
      ),
    );
    return;
  }

  printReport(catalogs, reports);

  if (apply) {
    await applyChanges(catalogs, reports);
  } else {
    const hasChanges = reports.some(
      (r) => r.unmatched.length > 0 || r.staleStatics.length > 0 || r.nameDrift.length > 0,
    );
    if (hasChanges) {
      console.log('Run with --apply (or `npm run models:audit:apply`) to update.');
    }
  }
}

main().catch((err) => {
  console.error('audit-models failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
