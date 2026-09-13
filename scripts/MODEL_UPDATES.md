# Updating model catalogs

The gateway owns the list shared by iOS, MC and web. The bundled catalogs live in
`apps/gateway/plugins/dash-core-providers/providers`. Use this procedure for
`/update-models`, release preparation, SDK changes and missing-model reports.

## Audit and review

1. Run `npm run models:audit -- --json`. Other providers use environment keys or
   this checkout's `.env.local`; OpenRouter uses its public API without a key.
   Failed, empty, malformed or incomplete snapshots must not be applied.
2. Read the full OpenRouter `frontier` report. `missing` includes missing exact
   allow-list coverage **or missing runtime metadata**. `metadataDrift` detects
   changed limits, modalities, reasoning support, names and base token pricing.
   `reviewCandidates` exposes eligible models outside reviewed families;
   `rejected` gives a reason for every incompatible or review-only model.
   `missingFamilies` flags a family with no eligible stable listing. Loss of a
   previously represented family blocks apply and CI. `newFamilyCandidates`
   blocks both for eligible unfamiliar listings published after the policy review.
3. Review unfamiliar families and pre-releases against provider documentation.
   Do not equate a recent publication, version number, large context window, or
   tool-support flag with benchmark quality or successful inference. Do not
   widen runtime globs to an entire vendor namespace. When a new family is
   approved, add a bounded selection rule in `scripts/openrouter-audit.ts` and
   a regression case before applying. Advance `OPENROUTER_FAMILY_REVIEWED_AT`
   only after reviewing the complete unfamiliar-family report and recording the
   decision in the PR. Apply never advances this timestamp automatically.
   New naming schemes require this review.
4. For other providers, review unmatched IDs, deny-list exclusions and proposed
   static removals. Add new allow-list patterns and accurate bootstrap metadata
   explicitly. A missing credential means that provider was not audited.

## OpenRouter policy

Reviewed families cover general reasoning, premium, fast and coding tiers from
OpenAI, Anthropic, Google, Z.ai, Moonshot, DeepSeek, Qwen, xAI, Mistral, Meta,
ByteDance Seed and MiniMax. Each tier selects its newest **OpenRouter listing**
by `created`, with deterministic ID tie-breaking. Review the proposed replacement:
publication time is not necessarily the model's original release date.

Candidates must advertise `tools`, accept text and produce text only, have at
least 32,768 context tokens and 4,096 output tokens, valid nonnegative token
pricing, complete limits and a non-expired endpoint. Colon variants (free/batch)
and preview/experimental/beta/alpha names require separate review. This is a
compatibility and curation policy, not a performance ranking or availability SLA.
Existing reviewed preview and older compatibility entries are retained; removal
is a separate explicit decision.

Applied selections get **exact** allow-list entries and concrete runtime metadata
from the same snapshot: context/output limits, reasoning, supported text/image
inputs and base per-million token prices. Unsupported video/file/audio inputs
are not advertised by Dash. Missing cache prices remain zero in Pi's required
cost shape; conditional pricing and per-request charges are not represented.
Known request compatibility overrides are preserved.

## Apply and verify

1. Run `npm run models:audit:apply -- --provider openrouter` to inspect and accept
   the update. `--yes` is available when the change has already been authorized.
   The command applies the exact audited snapshot, retains compatibility entries,
   validates the result, updates `reviewedAt`, and runs tests plus the live gate.
   It does not commit or deploy. Fetch and verification errors exit nonzero.
2. Inspect `git diff`. Bump the bundled plugin manifest's patch version whenever
   catalog content changes; the installer compares **plugin versions**. A root
   application version or review-date change alone does not install a new bundle.
3. Run `npm run preflight`. `models:check` checks both the oldest review date
   (warn at 30 days, fail at 60) and current OpenRouter coverage/metadata. It runs
   in CI and needs network access. An outage fails the audit without rewriting
   catalogs; retry after recovery. Do not bypass failure by changing the date.
4. Commit specific files, review the PR and deploy through the normal workflow.
   New approved-family releases are detected the next time this live audit runs;
   they reach users after the catalog is reviewed, shipped and loaded. This
   process does not promise unreviewed new models appear instantly.

## Verify delivery separately from discovery

After deployment, verify the installed plugin version and source content, reload
plugins, and inspect the exact `/mobile/v1/models` response through the user's
actual gateway/relay. Check model IDs, provider grouping and runtime metadata.
Finally verify the client picker; receiving a response alone does not prove the
installed UI rendered it.

The gateway re-fetches live lists on the first GET after six hours. Explicit
refresh and catalog-content changes invalidate sooner, including same-day edits.
A provider failure retains its last good rows, returns the error, and retries
on a GET after five minutes. All clients use the same controller and cache;
opening the iPad picker makes a GET. No background timer or polling is installed.
