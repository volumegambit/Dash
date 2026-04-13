#!/usr/bin/env npx tsx
/**
 * CI/lint freshness gate for the curated model lists in @dash/models.
 *
 * Reads `MODELS_REVIEWED_AT` from `@dash/models` and computes the age
 * in days since that timestamp. Behavior:
 *
 *   - 0–29 days: silent pass (exit 0)
 *   - 30–59 days: warn (exit 0)  → local builds and CI both warn,
 *     CLAUDE.md prompts a refresh at the next trigger point
 *   - ≥60 days:   hard fail (exit 1) → CI blocks the build, local
 *     `npm run preflight` blocks too. No env-var override —
 *     "strict" means strict.
 *
 * To unblock a hard fail: run `/update-models` (or
 * `npm run models:audit:apply`) which refreshes the allow-list and
 * bumps `MODELS_REVIEWED_AT`. Or, in a genuine emergency, manually
 * edit `MODELS_REVIEWED_AT` in supported-models.ts with a comment
 * in the commit explaining why the audit was skipped.
 */

import { MODELS_REVIEWED_AT } from '@dash/models';

const WARN_DAYS = 30;
const FAIL_DAYS = 60;

const reviewedAt = new Date(MODELS_REVIEWED_AT);
if (Number.isNaN(reviewedAt.getTime())) {
  console.error(
    `❌ MODELS_REVIEWED_AT in @dash/models is not a valid ISO date: '${MODELS_REVIEWED_AT}'`,
  );
  process.exit(1);
}

const ageMs = Date.now() - reviewedAt.getTime();
const ageDays = Math.floor(ageMs / 86_400_000);

if (ageDays >= FAIL_DAYS) {
  console.error(`❌ MODELS_REVIEWED_AT is ${ageDays} days old (hard limit: ${FAIL_DAYS} days).`);
  console.error('   The curated model allow-list and bootstrap list need a refresh.');
  console.error('   Run `/update-models` (or `npm run models:audit:apply`) to refresh,');
  console.error('   then commit the resulting changes to packages/models/.');
  process.exit(1);
}

if (ageDays >= WARN_DAYS) {
  console.warn(
    `⚠ MODELS_REVIEWED_AT is ${ageDays} days old (warn threshold: ${WARN_DAYS} days, hard fail at ${FAIL_DAYS}).`,
  );
  console.warn('   Plan to run `/update-models` soon.');
  // Warning only — exit 0 so local builds don't fail.
  process.exit(0);
}

// Quiet pass: < 30 days old, no output.
process.exit(0);
