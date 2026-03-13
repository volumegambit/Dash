# MC QA — Immediate Background Bug Filing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update `.claude/agents/mission-control-qa.md` to file Linear tickets via background subagents as each finding is discovered during Phase 3, rather than batching all filing into Phase 4.

**Architecture:** Four targeted edits to the single skill file: (1) add pre-flight to Phase 2, (2) add findings counter + step 3.S.6 to Phase 3, (3) strip Phase 4 to summary-only, (4) fix deduplication key in Key Constraint 3.

**Tech Stack:** Markdown editing only — no code files, no build step, no tests.

**Spec:** `docs/superpowers/specs/2026-03-14-mc-qa-immediate-background-filing-design.md`

---

## Chunk 1: All edits to `.claude/agents/mission-control-qa.md`

### Task 1: Add pre-flight step 2.4 to Phase 2

**Files:**
- Modify: `.claude/agents/mission-control-qa.md`

- [ ] **Step 1.1 — Replace the Phase 2 exit criteria block**

Using the Edit tool, replace this exact text:

```
**Exit criteria:** Test matrix written to working memory. Print:
> "Phase 2 complete — test matrix built. X routes, Y IPC handlers mapped."
```

With:

```
**Step 2.4 — Pre-flight for Linear filing**

Run these sub-steps in order before Phase 3 begins:

**2.4.1 — Resolve team ID**

Call `mcp__linear-server__list_teams`. Find the team with name "Dash". Record the `id` field of that team as `dashTeamId` (a UUID string). Pass this UUID as `teamId` to `list_issue_statuses`, `list_issue_labels`, and `save_issue`. Note: `list_issues` accepts a team name string (`team: Dash`) and does not require this UUID.

**2.4.2 — Resolve non-terminal state IDs**

Call `mcp__linear-server__list_issue_statuses` with `teamId: <dashTeamId>` (UUID from 2.4.1). Record the IDs of non-terminal states (typically "Todo", "In Progress", "In Review" — exclude "Done", "Cancelled", "Duplicate"). Store as `nonTerminalStateIds`.

**2.4.3 — Ensure labels exist**

Call `mcp__linear-server__list_issue_labels` with `teamId: <dashTeamId>`. For each of `automated-qa` and `mission-control`: if the label does not exist, create it with `mcp__linear-server__create_issue_label` (color `#6B7280` for `automated-qa`, `#8B5CF6` for `mission-control`). Record both label IDs. If either label cannot be resolved or created, treat the entire step 2.4 as failed.

**2.4 failure handling:** If any sub-step fails, print a warning — "Pre-flight failed: background filing disabled for this run" — and continue into Phase 3. Findings are still counted and recorded in working memory, but no background filing agents are spawned.

Store `dashTeamId`, `nonTerminalStateIds`, and both label IDs in working memory alongside the test matrix.

**Exit criteria:** Test matrix written to working memory. Print:

> "Phase 2 complete — test matrix built. X routes, Y IPC handlers mapped. Pre-flight complete — state IDs, label IDs, and team ID recorded."

If pre-flight failed:

> "Phase 2 complete — test matrix built. X routes, Y IPC handlers mapped. WARNING: pre-flight failed — background filing disabled."
```

- [ ] **Step 1.2 — Verify**

Read `.claude/agents/mission-control-qa.md` around the Phase 2 section. Confirm:
- Step 2.4 appears with all three sub-steps (2.4.1, 2.4.2, 2.4.3)
- Both exit criteria variants (normal and pre-flight failed) are present
- The old single-line exit criteria is gone

- [ ] **Step 1.3 — Commit**

```bash
git add .claude/agents/mission-control-qa.md
git commit -m "feat(mc-qa): add pre-flight step 2.4 to Phase 2"
```

---

### Task 2: Add findings counter and step 3.S.6 to Phase 3

**Files:**
- Modify: `.claude/agents/mission-control-qa.md`

- [ ] **Step 2.1 — Add findings tracking block before the Systematic Pass heading**

Using the Edit tool, replace:

```
### Systematic Pass

**Goal:** Walk the test matrix top to bottom, exercising every route and primary flow.
```

With:

```
**Findings tracking:** At the start of Phase 3, initialize two values in working memory:
- `findingsCount = 0` — total distinct findings discovered. This drives the `X` in the Phase 4 summary.
- `pendingFindings = []` — list of finding objects not yet dispatched to a background agent. Each finding object holds: area, screen/flow name, route URL, action sequence, observed, expected, error evidence, screenshot path, test phase.

When a finding is discovered: increment `findingsCount` by 1 and append a finding object to `pendingFindings`.

### Systematic Pass

**Goal:** Walk the test matrix top to bottom, exercising every route and primary flow.
```

- [ ] **Step 2.2 — Replace the "Recording a finding" line and exit criteria to insert step 3.S.6**

Using the Edit tool, replace:

```
**Recording a finding:** note the area, route, exact action sequence, observed vs. expected behavior, interceptor output, and screenshot path.

**Exit criteria:** All 5 priority areas exercised. Findings list assembled.
```

With the block below. Note: the background agent prompt uses `~~~` fences inside the outer ` ``` ` block to avoid nesting conflicts — keep them exactly as shown:

```
**Recording a finding:** note the area, screen/flow name, route URL, exact action sequence, observed vs. expected behavior, interceptor output, and screenshot path. Append to `pendingFindings` and increment `findingsCount`.

**3.S.6 — Report findings in background**

After step 3.S.5 (including clearing the interceptor arrays), dispatch all items in `pendingFindings` as separate background agents — one agent per finding — then clear `pendingFindings`.

Skip this step if pre-flight failed in step 2.4.

For each finding, spawn an Agent with `run_in_background: true` and `model: sonnet`. Background agents inherit the parent agent's MCP server configuration, so `mcp__linear-server__*` tools are available without additional setup. If a background agent fails at any point (including partial execution), the loss is silent and accepted — do not retry.

Construct each background agent prompt by substituting this template with the specific finding's data:

~~~
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
Run ID: <Phase 1 Run ID — e.g. mc-qa-20260314-143022>

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
~~~

**Exit criteria:** All 5 priority areas exercised. Findings list assembled.
```

- [ ] **Step 2.3 — Add dispatch trigger after the adversarial probe table**

Using the Edit tool, replace:

```
For each probe: capture a screenshot, check the error interceptor, record anything that counts as a finding.

**Exit criteria:** All fragile areas probed. All findings recorded with full action sequences.
```

With:

```
For each probe: capture a screenshot, check the error interceptor, record anything that counts as a finding. After each probe's check, dispatch all items in `pendingFindings` as background agents (same mechanism as step 3.S.6), then clear `pendingFindings`.

**Exit criteria:** All fragile areas probed. All findings recorded with full action sequences.
```

- [ ] **Step 2.4 — Verify**

Read the Phase 3 section of the skill file. Confirm:
- `findingsCount` and `pendingFindings` initialization appears before `### Systematic Pass`
- Step 3.S.6 appears after step 3.S.5, containing the full background agent prompt template with `~~~` fences
- The adversarial pass paragraph ends with the per-probe dispatch instruction

- [ ] **Step 2.5 — Commit**

```bash
git add .claude/agents/mission-control-qa.md
git commit -m "feat(mc-qa): add findings counter and step 3.S.6 background filing"
```

---

### Task 3: Rewrite Phase 4 to summary-only

**Files:**
- Modify: `.claude/agents/mission-control-qa.md`

- [ ] **Step 3.1 — Replace the Phase 4 Goal line**

Using the Edit tool, replace:

```
**Goal:** File all findings as Linear issues in the Dash team, deduplicated against existing open issues.
```

With:

```
**Goal:** Print the end-of-run summary.
```

- [ ] **Step 3.2 — Delete Pre-flight and filing sections, replace End-of-run summary**

Using the Edit tool, replace everything from `### Pre-flight` through the end of the old summary block.

**old_string** (use `~~~` fences when passing to Edit tool to avoid nesting conflicts with inner ` ``` ` blocks):

~~~
### Pre-flight (run once before filing any issue)

**4.P.1 — Resolve non-terminal state IDs**

Call `mcp__linear-server__list_issue_statuses` for the Dash team. Record the IDs of non-terminal states (typically "Todo", "In Progress", "In Review" — exclude "Done", "Cancelled", "Duplicate"). Use these IDs in the deduplication filter.

**4.P.2 — Ensure labels exist**

Call `mcp__linear-server__list_issue_labels` for the Dash team. For each of `automated-qa` and `mission-control`: if the label does not exist, create it with `mcp__linear-server__create_issue_label` (color `#6B7280` for `automated-qa`, `#8B5CF6` for `mission-control`). Record the label IDs.

### For each finding, in order of priority:

**4.1 — Deduplication check**

Call `mcp__linear-server__list_issues` with `query: "[MC] <Route>:"` and team: Dash.

Then **filter locally**: keep only issues whose `title` starts exactly with `[MC] <Route>:` AND whose `stateId` is one of the non-terminal state IDs from 4.P.1.

- **Match found** → call `mcp__linear-server__save_comment` with the following body:

  ```
  ## Re-observed — Run ID: mc-qa-YYYYMMDD-HHMMSS
  **Date:** YYYY-MM-DD

  **Action sequence:**
  1. <action taken>
  2. <action taken>
  ...

  **Error evidence:**
  <output from window.__qaErrors / window.__qaConsoleErrors>

  **Screenshot:** saved locally at /tmp/mc-qa-RUNID/AREA-STEP.png
  ```
- **No match** → call `mcp__linear-server__save_issue` using the template below

**4.2 — Issue template**

**Title:** `[MC] <Screen/Flow>: <one-line description>`
Example: `[MC] Deploy Flow: app hangs after saving credentials`

**Description:**
```
## What happened
<observed behavior>

## What was expected
<correct behavior>

## Steps to reproduce
1. <action taken>
2. <action taken>
...

## Error evidence
<output from window.__qaErrors / window.__qaConsoleErrors>

## App state
<route, visible UI state at time of failure>

## Test phase
Systematic | Adversarial

## Run ID
mc-qa-YYYYMMDD-HHMMSS

## Screenshot
Saved locally: /tmp/mc-qa-RUNID/AREA-STEP.png
```

**Labels:** IDs from 4.P.2 (`automated-qa`, `mission-control`)

**Priority mapping:**
| Severity | Linear priority |
|---|---|
| Crash / uncaught exception | 1 (Urgent) |
| Broken primary flow | 2 (High) |
| Stuck state / no feedback | 3 (Medium) |
| Inconsistent UI | 3 (Medium) |

### End-of-run summary

Print to terminal:
```
MC QA Run mc-qa-YYYYMMDD-HHMMSS complete
─────────────────────────────────────────
Findings:     X functional failures
New tickets:  Y created in Linear (Dash team)
Duplicates:   Z commented on existing issues

Screenshots saved to: /tmp/mc-qa-RUNID/
```
~~~

**new_string** (use `~~~` fences when passing to Edit tool):

~~~
### End-of-run summary

If pre-flight succeeded, print:

```
MC QA Run mc-qa-YYYYMMDD-HHMMSS complete
─────────────────────────────────────────
Findings:     X functional failures
Tickets:      filed in background as found (may still be processing)

Screenshots saved to: /tmp/mc-qa-RUNID/
```

If pre-flight failed, print:

```
MC QA Run mc-qa-YYYYMMDD-HHMMSS complete
─────────────────────────────────────────
Findings:     X functional failures
Tickets:      none filed — pre-flight failed before run

Screenshots saved to: /tmp/mc-qa-RUNID/
```
~~~

- [ ] **Step 3.3 — Verify**

Read the Phase 4 section of the skill file. Confirm:
- Only `**Goal:** Print the end-of-run summary.` and the `### End-of-run summary` block remain
- Both summary variants (normal and pre-flight-failed) are present
- No mention of 4.P.1, 4.P.2, 4.1, 4.2, or "New tickets" / "Duplicates" anywhere in Phase 4

- [ ] **Step 3.4 — Commit**

```bash
git add .claude/agents/mission-control-qa.md
git commit -m "feat(mc-qa): strip Phase 4 to summary-only"
```

---

### Task 4: Fix Key Constraint 3

**Files:**
- Modify: `.claude/agents/mission-control-qa.md`

- [ ] **Step 4.1 — Update the deduplication key wording**

Using the Edit tool, replace:

```
3. **One ticket per distinct failure** — deduplication key is the `[MC] <Route>:` title prefix.
```

With:

```
3. **One ticket per distinct failure** — deduplication key is the `[MC] <Screen/Flow>:` title prefix.
```

- [ ] **Step 4.2 — Verify**

Read the Key Constraints section. Confirm constraint 3 reads `[MC] <Screen/Flow>:`.

- [ ] **Step 4.3 — Final read of the full skill file**

Read the entire `.claude/agents/mission-control-qa.md` and confirm:
- Phase 1 and Phase 2 (steps 2.1–2.3) are unchanged
- Step 2.4 is present with 3 sub-steps and both exit criteria variants
- Phase 3 has `findingsCount`/`pendingFindings` init block before `### Systematic Pass`
- Step 3.S.6 is present in the systematic pass with the full background agent prompt template
- The adversarial pass ends with a per-probe dispatch instruction
- Phase 4 contains only Goal + End-of-run summary (two variants)
- Key Constraint 3 uses `[MC] <Screen/Flow>:`
- No stray references to 4.P.1, 4.P.2, 4.1, 4.2, `[MC] <Route>:` remain

- [ ] **Step 4.4 — Commit**

```bash
git add .claude/agents/mission-control-qa.md
git commit -m "fix(mc-qa): correct deduplication key in Key Constraint 3"
```
