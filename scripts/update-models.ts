#!/usr/bin/env npx tsx
/**
 * Model allow-list management tool.
 *
 * Reads the current model cache (data/models-cache.json), compares every
 * discovered model against the curated allow-list in supported-models.ts,
 * and prints a report showing what's included, excluded, and unrecognized.
 *
 * Usage:
 *   npx tsx scripts/update-models.ts              # Show report
 *   npx tsx scripts/update-models.ts --refresh    # Refresh cache first, then report
 *   npx tsx scripts/update-models.ts --json       # Output as JSON
 *
 * To add a new model, edit: packages/mc/src/models/supported-models.ts
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SUPPORTED_MODELS,
  findSupportedModel,
  globToRegex,
} from '../packages/mc/src/models/supported-models.js';

interface RawCacheModel {
  value: string;
  label: string;
  provider: string;
}

interface CacheFile {
  fetchedAt: string;
  models: RawCacheModel[];
}

const DATA_DIR = join(import.meta.dirname, '..', 'data');
const CACHE_PATH = join(DATA_DIR, 'models-cache.json');
const SUPPORTED_MODELS_PATH = 'packages/mc/src/models/supported-models.ts';

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const shouldRefresh = args.includes('--refresh');

async function loadRawCache(): Promise<RawCacheModel[]> {
  if (!existsSync(CACHE_PATH)) return [];
  const raw = await readFile(CACHE_PATH, 'utf-8');
  const cache = JSON.parse(raw) as CacheFile;
  return cache.models ?? [];
}

async function refreshCache(): Promise<RawCacheModel[]> {
  // Dynamic import to avoid loading heavy deps unless needed
  const { ModelCacheService } = await import('../packages/mc/src/models/model-cache.js');
  const cache = new ModelCacheService(DATA_DIR);
  const models = await cache.refresh();
  return models;
}

interface ModelReport {
  provider: string;
  modelId: string;
  label: string;
  status: 'allowed' | 'filtered';
  matchedPattern?: string;
  tier?: number;
}

function analyzeModels(models: RawCacheModel[]): ModelReport[] {
  return models.map((m) => {
    const modelId = m.value.includes('/') ? m.value.split('/')[1] : m.value;
    const match = findSupportedModel(m.provider, modelId);
    return {
      provider: m.provider,
      modelId,
      label: m.label,
      status: match ? 'allowed' : 'filtered',
      matchedPattern: match?.pattern,
      tier: match?.tier,
    };
  });
}

function printReport(reports: ModelReport[]): void {
  const providers = [...new Set(reports.map((r) => r.provider))].sort();

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    MODEL ALLOW-LIST REPORT                  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const allowed = reports.filter((r) => r.status === 'allowed');
  const filtered = reports.filter((r) => r.status === 'filtered');

  console.log(`  Total discovered: ${reports.length}`);
  console.log(`  Allowed:          ${allowed.length} (shown in UI)`);
  console.log(`  Filtered:         ${filtered.length} (hidden from UI)\n`);

  for (const provider of providers) {
    const providerReports = reports.filter((r) => r.provider === provider);
    const providerAllowed = providerReports.filter((r) => r.status === 'allowed');
    const providerFiltered = providerReports.filter((r) => r.status === 'filtered');

    console.log(
      `── ${provider.toUpperCase()} (${providerAllowed.length} allowed, ${providerFiltered.length} filtered) ──`,
    );

    if (providerAllowed.length > 0) {
      console.log('  Allowed:');
      for (const r of providerAllowed.sort((a, b) => (a.tier ?? 99) - (b.tier ?? 99))) {
        console.log(
          `    ✓ ${r.label.padEnd(30)} ${r.modelId.padEnd(35)} tier=${r.tier} pattern=${r.matchedPattern}`,
        );
      }
    }

    if (providerFiltered.length > 0) {
      console.log('  Filtered out:');
      for (const r of providerFiltered.sort((a, b) => a.modelId.localeCompare(b.modelId))) {
        console.log(`    ✗ ${r.label.padEnd(30)} ${r.modelId}`);
      }
    }
    console.log();
  }

  // Show allow-list patterns with no matches (stale patterns)
  const usedPatterns = new Set(
    reports.filter((r) => r.matchedPattern).map((r) => r.matchedPattern),
  );
  const stalePatterns = SUPPORTED_MODELS.filter((e) => !usedPatterns.has(e.pattern));
  if (stalePatterns.length > 0) {
    console.log('── STALE PATTERNS (no models matched) ──');
    for (const e of stalePatterns) {
      console.log(`    ⚠ ${e.provider}/${e.pattern}`);
    }
    console.log();
  }

  if (filtered.length > 0) {
    console.log(`To allow a filtered model, add a pattern to:\n  ${SUPPORTED_MODELS_PATH}\n`);
  }
}

// Main
async function main(): Promise<void> {
  let rawModels: RawCacheModel[];

  if (shouldRefresh) {
    console.log('Refreshing model cache from providers...');
    rawModels = await refreshCache();
    console.log(`Fetched ${rawModels.length} models.\n`);

    // For the report, reload the UNFILTERED cache to show what was filtered
    // The refresh already filtered, so we need the raw provider data
    // Instead, we'll just report on what's in the cache after filtering
  } else {
    rawModels = await loadRawCache();
    if (rawModels.length === 0) {
      console.log(
        'No model cache found. Run with --refresh or refresh from Mission Control first.',
      );
      console.log(`  Expected cache at: ${CACHE_PATH}\n`);
      console.log('Showing allow-list patterns only:\n');
      for (const e of SUPPORTED_MODELS) {
        console.log(`  ${e.provider.padEnd(12)} ${e.pattern.padEnd(25)} tier=${e.tier}`);
      }
      process.exit(0);
    }
  }

  const reports = analyzeModels(rawModels);

  if (jsonOutput) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    printReport(reports);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
