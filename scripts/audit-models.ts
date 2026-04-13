#!/usr/bin/env npx tsx
/**
 * Audit script for the curated model lists in @dash/models.
 *
 * What it does:
 *   1. Loads provider credentials from process.env (then .env.local at
 *      repo root via a tiny inline parser).
 *   2. For each provider in the registry that has a credential, calls
 *      its /v1/models endpoint via the same fetcher the gateway uses.
 *   3. Diffs the live response against:
 *        - SUPPORTED_MODELS allow-list patterns
 *        - BOOTSTRAP_MODELS curated seed list
 *   4. Prints a human-readable report (or --json for machine output).
 *   5. With --apply, walks the diffs interactively, applies accepted
 *      changes via file rewrites, bumps MODELS_REVIEWED_AT to today,
 *      runs npm test + npm run models:check, and prints git diff for
 *      the user to commit.
 *
 * Usage:
 *   npm run models:audit                   # read-only report
 *   npm run models:audit -- --json         # machine-readable output
 *   npm run models:audit:apply             # interactive update mode
 *
 * Credentials:
 *   The script looks for ANTHROPIC_API_KEY / OPENAI_API_KEY /
 *   GOOGLE_API_KEY in process.env first. If not found, loads from
 *   .env.local at the repo root. Missing credentials = provider is
 *   skipped silently (the report still shows allow-list patterns
 *   and current BOOTSTRAP_MODELS for that provider).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  BOOTSTRAP_MODELS,
  type FilteredModel,
  MODELS_REVIEWED_AT,
  PROVIDERS,
  type ProviderDefinition,
  type RawModel,
  SUPPORTED_MODELS,
  applySupportedFilter,
  findSupportedModel,
} from '@dash/models';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SUPPORTED_PATH = join(REPO_ROOT, 'packages/models/src/supported-models.ts');
const BOOTSTRAP_PATH = join(REPO_ROOT, 'packages/models/src/bootstrap-models.ts');

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
};

function resolveCredential(
  provider: ProviderDefinition,
  env: Record<string, string>,
): string | null {
  const key = ENV_KEYS[provider.id];
  if (!key) return null;
  return process.env[key] || env[key] || null;
}

// ---------------------------------------------------------------------------
// Discovery + diff
// ---------------------------------------------------------------------------

interface ProviderReport {
  provider: string;
  configured: boolean;
  fetchError?: string;
  raw: RawModel[];
  filtered: FilteredModel[];
  unmatched: RawModel[];
  bootstrapInList: FilteredModel[];
  bootstrapMissing: FilteredModel[];
}

async function gatherReport(): Promise<ProviderReport[]> {
  const env = loadEnvLocal();
  const reports: ProviderReport[] = [];

  for (const provider of PROVIDERS) {
    const apiKey = resolveCredential(provider, env);
    if (!apiKey) {
      reports.push({
        provider: provider.id,
        configured: false,
        raw: [],
        filtered: [],
        unmatched: [],
        bootstrapInList: BOOTSTRAP_MODELS.filter((m) => m.provider === provider.id),
        bootstrapMissing: [],
      });
      continue;
    }

    let raw: RawModel[] = [];
    let fetchError: string | undefined;
    try {
      raw = await provider.fetchModels(apiKey);
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }

    const filtered = applySupportedFilter(raw);
    const unmatched = raw.filter((m) => !findSupportedModel(m.provider, m.id));

    const liveValues = new Set(raw.map((m) => `${m.provider}/${m.id}`));
    const bootstrapInList = BOOTSTRAP_MODELS.filter((m) => m.provider === provider.id);
    const bootstrapMissing = bootstrapInList.filter((m) => !liveValues.has(m.value));

    reports.push({
      provider: provider.id,
      configured: true,
      fetchError,
      raw,
      filtered,
      unmatched,
      bootstrapInList,
      bootstrapMissing,
    });
  }

  return reports;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printReport(reports: ProviderReport[]): void {
  console.log();
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║                MODEL ALLOW-LIST AUDIT REPORT                 ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log();
  console.log(`MODELS_REVIEWED_AT: ${MODELS_REVIEWED_AT}`);
  const ageDays = Math.floor((Date.now() - new Date(MODELS_REVIEWED_AT).getTime()) / 86_400_000);
  console.log(`Age:                ${ageDays} days`);
  console.log();

  for (const report of reports) {
    console.log(`── ${report.provider.toUpperCase()} ──`);
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
    console.log(`  Total returned by API: ${report.raw.length}`);
    console.log(`  Matched by allow-list: ${report.filtered.length}`);
    console.log(`  Unmatched (potential additions): ${report.unmatched.length}`);
    if (report.unmatched.length > 0 && report.unmatched.length <= 20) {
      for (const m of report.unmatched) {
        console.log(`    • ${m.id.padEnd(40)} ${m.label}`);
      }
    } else if (report.unmatched.length > 20) {
      for (const m of report.unmatched.slice(0, 20)) {
        console.log(`    • ${m.id.padEnd(40)} ${m.label}`);
      }
      console.log(`    ... and ${report.unmatched.length - 20} more`);
    }
    console.log(`  Bootstrap entries:     ${report.bootstrapInList.length}`);
    if (report.bootstrapMissing.length > 0) {
      console.log('  Bootstrap entries no longer in API:');
      for (const m of report.bootstrapMissing) {
        console.log(`    ⚠ ${m.value}  ← suggest removal`);
      }
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Apply mode (interactive file rewrites)
// ---------------------------------------------------------------------------

/**
 * Compute the new BOOTSTRAP_MODELS as "top-N-per-tier-per-provider" from
 * live data. For each provider, take the alphabetically-smallest model
 * id within each distinct tier, keeping at most 3 entries per provider.
 * Deterministic so a re-audit produces identical output unless the
 * upstream provider list changed.
 */
function computeBootstrap(reports: ProviderReport[]): FilteredModel[] {
  const out: FilteredModel[] = [];
  for (const report of reports) {
    if (!report.configured || report.fetchError) {
      // Keep existing bootstrap entries for providers we couldn't audit
      out.push(...report.bootstrapInList);
      continue;
    }
    const byTier = new Map<number, FilteredModel>();
    for (const fm of report.filtered) {
      const id = fm.value.includes('/') ? fm.value.split('/')[1] : fm.value;
      const entry = findSupportedModel(report.provider, id);
      if (!entry) continue;
      const existing = byTier.get(entry.tier);
      if (!existing || fm.value < existing.value) {
        byTier.set(entry.tier, fm);
      }
    }
    const tiers = [...byTier.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, 3)
      .map(([, m]) => m);
    out.push(...tiers);
  }
  return out;
}

function renderBootstrapFile(models: FilteredModel[]): string {
  const grouped = new Map<string, FilteredModel[]>();
  for (const m of models) {
    if (!grouped.has(m.provider)) grouped.set(m.provider, []);
    grouped.get(m.provider)?.push(m);
  }
  const lines: string[] = [
    `import type { FilteredModel } from './types.js';`,
    '',
    '/**',
    ' * Curated bootstrap model list returned by the gateway when **no provider',
    ' * credentials are configured at all**. Used purely for discoverability —',
    ` * gives MC's deploy form something to render so the user can see what`,
    ' * models would be available if they added credentials.',
    ' *',
    ' * **Auto-generated by `scripts/audit-models.ts --apply`** from live',
    ' * provider /models responses, picking the top model per tier per',
    ' * provider (capped at 3 per provider). Manual edits will be overwritten',
    ' * on the next audit run.',
    ' */',
    'export const BOOTSTRAP_MODELS: FilteredModel[] = [',
  ];
  for (const [provider, ms] of grouped) {
    const niceProvider = provider.charAt(0).toUpperCase() + provider.slice(1);
    lines.push(`  // ${niceProvider}`);
    for (const m of ms) {
      lines.push('  {');
      lines.push(`    value: ${JSON.stringify(m.value)},`);
      lines.push(`    label: ${JSON.stringify(m.label)},`);
      lines.push(`    provider: ${JSON.stringify(m.provider)},`);
      lines.push('  },');
    }
  }
  lines.push('];');
  lines.push('');
  return lines.join('\n');
}

function bumpReviewedAt(): void {
  const today = new Date().toISOString().slice(0, 10);
  const text = readFileSync(SUPPORTED_PATH, 'utf-8');
  const next = text.replace(
    /export const MODELS_REVIEWED_AT = '[\d-]+';/,
    `export const MODELS_REVIEWED_AT = '${today}';`,
  );
  if (next === text) {
    console.warn('Could not find MODELS_REVIEWED_AT to bump in supported-models.ts');
    return;
  }
  writeFileSync(SUPPORTED_PATH, next);
  console.log(`Bumped MODELS_REVIEWED_AT → ${today}`);
}

async function applyChanges(reports: ProviderReport[]): Promise<void> {
  const rl = createInterface({ input, output });
  const ask = async (q: string): Promise<boolean> => {
    const a = await rl.question(`${q} [y/N] `);
    return a.toLowerCase().startsWith('y');
  };

  const newBootstrap = computeBootstrap(reports);
  const currentBootstrap = BOOTSTRAP_MODELS;
  const bootstrapChanged = JSON.stringify(newBootstrap) !== JSON.stringify(currentBootstrap);

  if (bootstrapChanged) {
    console.log();
    console.log('Proposed BOOTSTRAP_MODELS update:');
    console.log(`  ${currentBootstrap.length} entries → ${newBootstrap.length} entries`);
    for (const m of newBootstrap) {
      console.log(`  ${m.value}`);
    }
    if (await ask('Apply BOOTSTRAP_MODELS update?')) {
      writeFileSync(BOOTSTRAP_PATH, renderBootstrapFile(newBootstrap));
      console.log('Wrote bootstrap-models.ts');
    } else {
      console.log('Skipped bootstrap update.');
    }
  } else {
    console.log('BOOTSTRAP_MODELS already in sync. No change.');
  }

  // Pattern additions are not auto-applied (they require human judgment
  // about glob shape). Print suggested additions and let the user edit
  // supported-models.ts manually.
  const suggestions: string[] = [];
  for (const report of reports) {
    if (!report.configured || report.unmatched.length === 0) continue;
    suggestions.push(`  // ${report.provider}:`);
    for (const m of report.unmatched.slice(0, 10)) {
      suggestions.push(`  //   ${m.id}`);
    }
  }
  if (suggestions.length > 0) {
    console.log();
    console.log('Unmatched models (to add to SUPPORTED_MODELS, edit by hand):');
    for (const s of suggestions) console.log(s);
  }

  if (await ask('Bump MODELS_REVIEWED_AT to today?')) {
    bumpReviewedAt();
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
    execFileSync('git', ['diff', 'packages/models/'], { stdio: 'inherit', cwd: REPO_ROOT });
  } catch {
    /* git not in this dir */
  }

  rl.close();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const reports = await gatherReport();

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          reviewedAt: MODELS_REVIEWED_AT,
          patterns: SUPPORTED_MODELS,
          bootstrap: BOOTSTRAP_MODELS,
          providers: reports,
        },
        null,
        2,
      ),
    );
    return;
  }

  printReport(reports);

  if (apply) {
    await applyChanges(reports);
  } else {
    const hasUnmatched = reports.some((r) => r.unmatched.length > 0);
    const hasBootstrapDrift = reports.some((r) => r.bootstrapMissing.length > 0);
    if (hasUnmatched || hasBootstrapDrift) {
      console.log('Run with --apply (or `npm run models:audit:apply`) to update.');
    }
  }
}

main().catch((err) => {
  console.error('audit-models failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
