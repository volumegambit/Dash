# MC QA — Immediate Background Bug Filing

**Date:** 2026-03-14
**Status:** Approved

## Problem

The current `mission-control-qa` skill defers all Linear ticket creation to Phase 4, after all testing is complete. This means findings sit in working memory for the entire test run before being filed. If the run is interrupted, findings are lost. It also means the agent spends sequential time filing after testing rather than overlapping the two.

## Goal

File (or comment on) each Linear issue as soon as it is found during Phase 3, using a background subagent so testing continues without blocking.

## Changes

### 1 — Pre-flight moves to Phase 2 (new step 2.4)

After producing the test matrix (step 2.3), add step 2.4 with these sub-steps in order:

**2.4.1 — Resolve team ID**

Call `mcp__linear-server__list_teams`. Find the team with name "Dash". Record the `id` field of that team as `dashTeamId` (a UUID string). Pass this UUID as `teamId` to `list_issue_statuses`, `list_issue_labels`, and `save_issue`. Note: `list_issues` accepts a team name string (`team: Dash`) and does not require this UUID.

**2.4.2 — Resolve non-terminal state IDs**

Call `mcp__linear-server__list_issue_statuses` with `teamId: <dashTeamId>` (UUID from 2.4.1). Record the IDs of non-terminal states (typically "Todo", "In Progress", "In Review" — exclude "Done", "Cancelled", "Duplicate"). Store as `nonTerminalStateIds`.

**2.4.3 — Ensure labels exist**

Call `mcp__linear-server__list_issue_labels` with `teamId: <dashTeamId>`. For each of `automated-qa` and `mission-control`: if the label does not exist, create it with `mcp__linear-server__create_issue_label` (color `#6B7280` for `automated-qa`, `#8B5CF6` for `mission-control`). Record both label IDs. If either label cannot be resolved or created, treat the entire step 2.4 as failed.

**2.4 failure handling:** If any sub-step fails, print a warning — "Pre-flight failed: background filing disabled for this run" — and continue into Phase 3. Findings are still counted and recorded in working memory, but no background filing agents are spawned.

**Phase 2 exit criteria** — replace the existing `> "Phase 2 complete..."` blockquote with:

> "Phase 2 complete — test matrix built. X routes, Y IPC handlers mapped. Pre-flight complete — state IDs, label IDs, and team ID recorded."

If pre-flight failed:

> "Phase 2 complete — test matrix built. X routes, Y IPC handlers mapped. WARNING: pre-flight failed — background filing disabled."

### 2 — New step 3.S.6 — Report findings in background

**Maintain two counters at the start of Phase 3:**
- `findingsCount = 0` — total distinct findings discovered. This is the `X` in the Phase 4 summary.
- `pendingFindings = []` — list of finding objects not yet dispatched. Each finding object holds: area, screen/flow name, route URL, action sequence, observed, expected, error evidence, screenshot path, test phase.

**When a finding is discovered:** increment `findingsCount` by 1 and append a finding object to `pendingFindings`.

**When to fire step 3.S.6:**
- **Systematic pass:** After step 3.S.5 (interceptor check), dispatch all items in `pendingFindings` as separate background agents (one agent per finding), then clear `pendingFindings`.
- **Adversarial pass:** After each individual probe row's screenshot + interceptor check, dispatch all items in `pendingFindings` as separate background agents, then clear `pendingFindings`.

If pre-flight failed, skip dispatching — do not fire step 3.S.6 at all.

Spawn each background agent using the Agent tool with `run_in_background: true` and `model: sonnet`. Background agents inherit the parent agent's MCP server configuration, so `mcp__linear-server__*` tools are available without additional setup.

**Failure handling:** Background agents run independently. If a background agent fails at any point — including partial execution (e.g. dedup check succeeded but filing failed) — the loss is silent and accepted. The main agent takes no action and does not retry.

**Background agent prompt template:**

```
You are a Linear bug reporter. File one bug finding from a Mission Control QA run.
You have access to mcp__linear-server__* tools.

## Finding

Area: <area>
Screen/Flow: <human-readable screen or flow name — e.g. "Deploy Flow", "Secrets", "Agent Detail">
Route: <URL path — e.g. /deploy, /secrets, /agents/$id>
Action sequence:
1. <step>
2. <step>
...
Observed: <observed behavior>
Expected: <correct behavior>
Error evidence: <window.__qaErrors / window.__qaConsoleErrors output>
Screenshot: <local path>
Test phase: Systematic | Adversarial
Run ID: <run-id>

## Pre-flight data

Dash team ID: <dashTeamId>
Non-terminal state IDs: [<id1>, <id2>, ...]
Label IDs:
  automated-qa: <label-id>
  mission-control: <label-id>

## Instructions

**Step 1 — Deduplication check**

Call mcp__linear-server__list_issues with query "[MC] <Screen/Flow>:" and team: Dash.
Use the Screen/Flow name from the Finding section above — not the URL path.

Filter locally: keep only issues whose title starts exactly with "[MC] <Screen/Flow>:" AND
whose stateId is one of the non-terminal state IDs above.

**Step 2a — Match found**

Extract the `id` field from the matching issue. Call mcp__linear-server__save_comment with
that issueId and body:

  ## Re-observed — Run ID: <run-id>
  **Date:** <YYYY-MM-DD>

  **Action sequence:**
  1. <action>
  ...

  **Error evidence:**
  <interceptor output>

  **Screenshot:** saved locally at <path>

**Step 2b — No match**

Call mcp__linear-server__save_issue with:

teamId: <dashTeamId>
title: [MC] <Screen/Flow>: <one-line description>
labelIds: [<automated-qa label ID>, <mission-control label ID>]
priority: (see mapping below)
description: (markdown body as below)

Do NOT set stateId — let Linear assign its default.

Description body:
  ## What happened
  <observed behavior>

  ## What was expected
  <correct behavior>

  ## Steps to reproduce
  1. <action>
  ...

  ## Error evidence
  <interceptor output>

  ## App state
  <route, visible UI state at time of failure>

  ## Test phase
  Systematic | Adversarial

  ## Run ID
  <run-id>

  ## Screenshot
  Saved locally: <path>

Priority mapping:
  Crash / uncaught exception → 1 (Urgent)
  Broken primary flow → 2 (High)
  Stuck state / no feedback → 3 (Medium)
  Inconsistent UI → 3 (Medium)

Print "Filed: <issue title or comment URL>" when done.
```

### 3 — Phase 4 becomes summary only

**Deleted from Phase 4:**
- The `**Goal:**` line — replace with: `**Goal:** Print the end-of-run summary.`
- The entire `### Pre-flight (run once before filing any issue)` section — heading and all content (steps 4.P.1 and 4.P.2).
- The entire `### For each finding, in order of priority:` section — heading and all content (steps 4.1 and 4.2 including the issue template).

**Retained:** The `### End-of-run summary` section heading only. The existing print block content (which includes `New tickets: Y` and `Duplicates: Z`) is replaced entirely with the new content below.

**Normal run (pre-flight succeeded):**
```
MC QA Run mc-qa-YYYYMMDD-HHMMSS complete
─────────────────────────────────────────
Findings:     X functional failures
Tickets:      filed in background as found (may still be processing)

Screenshots saved to: /tmp/mc-qa-RUNID/
```

**Pre-flight failed run:**
```
MC QA Run mc-qa-YYYYMMDD-HHMMSS complete
─────────────────────────────────────────
Findings:     X functional failures
Tickets:      none filed — pre-flight failed before run

Screenshots saved to: /tmp/mc-qa-RUNID/
```

## Deduplication Key Correction

The existing skill's step 4.1 uses `query: "[MC] <Route>:"` for deduplication while step 4.2 defines issue titles as `[MC] <Screen/Flow>: <description>`. These are inconsistent — routes are URL paths (`/deploy`) while screen/flow names are human-readable (`Deploy Flow`). The background agent prompt uses `[MC] <Screen/Flow>:` to match the actual title format defined in 4.2. This corrects the inconsistency. The implementer should also update the existing step 4.1 query text to use `[MC] <Screen/Flow>:` for consistency, though that step is being deleted as part of this change.

## What Does Not Change

- The finding definition (what counts as a finding) is unchanged.
- The issue template content and priority mapping are unchanged.
- `stateId` is not set on new issues — Linear's default state is used, consistent with the existing skill.
- Phase 1, Phase 2 (steps 2.1–2.3), and Phase 3 test flows (3.S.1–3.S.5, adversarial pass prose and table) are unchanged except for the additions in step 2.4 and step 3.S.6.
- Key Constraints 1, 2, 4, 5, 6 are unchanged. Key Constraint 3 must be updated: replace `[MC] <Route>:` with `[MC] <Screen/Flow>:` to match the corrected deduplication key (see Deduplication Key Correction section).

## Trade-offs

| | Background per finding (chosen) | Inline synchronous |
|---|---|---|
| Testing throughput | Unblocked — continues immediately | Blocked during each MCP call |
| Finding durability | Filed as discovered | Lost if run interrupted |
| Summary accuracy | Cannot report new vs duplicate totals | Can report exact totals |
| Background failure | Silent (including partial execution) — accepted | N/A |
| Pre-flight failure | Warns, continues, prints alternate summary | N/A |
| Complexity | Requires constructing subagent prompts | Simpler inline execution |
