# Mission Control QA Skill — Design Spec

**Date**: 2026-03-14
**Status**: Approved
**Topic**: Exhaustive automated QA skill for the Mission Control Electron app with Linear bug reporting

---

## Overview

A project-scoped Claude Code agent skill (`.claude/agents/mission-control-qa.md`) that turns the Claude Code agent into a dedicated QA engineer for the Mission Control desktop app. When invoked, the skill drives Mission Control via the Chrome DevTools Protocol (CDP), systematically tests all screens and flows, adversarially probes for edge cases, and reports functional failures to Linear under the Dash team.

**Trigger phrases**: `"Run MC QA"`, `"Test Mission Control"`, `"exhaustive QA"`

---

## Goals

1. Achieve exhaustive functional coverage of Mission Control — every route, every primary IPC handler, every major user flow
2. Surface functional failures (broken flows, stuck states, uncaught exceptions, IPC errors) that unit and component tests miss
3. File well-structured Linear issues under the Dash team, deduplicated across runs
4. Require zero code maintenance — the skill is a pure markdown agent profile; all tool calls go through the `electron` skill (CDP) and the Linear MCP

---

## Non-Goals

- Visual regression testing (pixel diffs, layout screenshots as ground truth)
- Performance benchmarking
- Testing the packaged/built app (dev mode only for now)
- Automated remediation of found bugs

---

## Architecture

```
.claude/agents/mission-control-qa.md   ← the skill (agent profile)
      │
      ├── electron skill                ← CDP connection + browser automation
      │     └── Chrome DevTools Protocol → running Mission Control window
      │
      └── Linear MCP                   ← mcp__linear-server__* tools
            ├── list_issues             → deduplication check
            ├── save_issue              → create new bug ticket
            └── save_comment           → add evidence to duplicate
```

**Skill file location**: `.claude/agents/mission-control-qa.md`
**No utility scripts** — Linear MCP handles all API calls. Zero code to maintain.

---

## The 4 Phases

### Phase 1 — Connect

**Goal**: Attach CDP to a running Mission Control window, or launch one.

Steps:
1. Check for a running Electron process with `mission-control` in its name (using `ps aux` or process listing via CDP discovery at `http://localhost:9222/json`)
2. **If running**: attach CDP to the existing window
3. **If not running**: execute `npm run mc:dev` from `apps/mission-control/`, wait for the Electron window to appear, then attach CDP
4. Verify connection by confirming window title contains "Mission Control"
5. Subscribe to CDP events for the session:
   - `Runtime.consoleAPICalled` — capture all console output
   - `Runtime.exceptionThrown` — capture uncaught exceptions
6. Record **Run ID**: `mc-qa-YYYYMMDD-HHMMSS` (used to correlate all Linear tickets from this session)

**Exit criteria**: CDP attached, event listeners active, Run ID recorded.

---

### Phase 2 — Map

**Goal**: Build a prioritized test matrix from source, not from assumptions.

Steps:
1. Read `src/renderer/src/routes/` to enumerate all navigable routes
2. Read `src/shared/ipc.ts` to enumerate all IPC channels, grouped by domain
3. Produce a prioritized test matrix:

| Priority | Area | Rationale |
|---|---|---|
| 1 | Deploy flow + secrets | Core action; touches IPC, encryption, process spawning |
| 2 | Chat interface | WebSocket streaming; most stateful component |
| 3 | Connections (Telegram/WhatsApp) | External deps; pairing flows; QR code rendering |
| 4 | Agent lifecycle (start/stop/remove) | Process management; easy to corrupt state |
| 5 | Settings, Skills editor | Lower stakes but frequent usage |

**Exit criteria**: Test matrix documented in agent's working memory before any app interaction begins.

---

### Phase 3 — Execute

#### Systematic Pass

Walk the test matrix top to bottom. For each area:
1. Navigate to the route via CDP
2. Interact with all primary UI elements (buttons, inputs, dropdowns, toggles)
3. Trigger the main happy-path flow (e.g., for Deploy: fill config → save → start agent)
4. Capture a CDP screenshot at each step boundary
5. Log all console errors and exceptions from the event listeners

What counts as a finding:
- Any uncaught JS exception
- Any IPC call that returns an error or times out
- Any UI state that appears stuck (spinner that never resolves, button that doesn't respond)
- Any route that fails to render (blank screen, error boundary triggered)
- Any form that submits but produces no observable feedback

#### Adversarial Pass

After the systematic pass, revisit anything that looked fragile. Probes:

| Probe type | Example |
|---|---|
| Empty inputs | Submit deploy form with no fields filled |
| Oversized inputs | Paste 10,000-character string into agent name field |
| Rapid repeated clicks | Double/triple-click Start agent button |
| Navigate away mid-flow | Start deploy → immediately switch routes |
| Simultaneous IPC calls | Trigger two conflicting operations at once |
| Error recovery | After an IPC error, can the user retry successfully? |
| Missing credentials | Try to start agent with no API key configured |

**Exit criteria**: All matrix items exercised in systematic pass, adversarial probes run on fragile areas. All findings logged with route, action sequence, observed vs. expected behavior, and any error output.

---

### Phase 4 — Report

For each functional failure found during Phase 3:

#### Deduplication check

Search Linear using `mcp__linear-server__list_issues` filtered to the Dash team for open issues whose title begins with `[MC] <Route>:` matching the current finding's route.

- **Match found** → add a comment via `mcp__linear-server__save_comment` with: Run ID, date, action sequence that reproduced it, error output, and CDP screenshot
- **No match** → create a new issue via `mcp__linear-server__save_issue` using the template below

#### Linear issue template

**Title**: `[MC] <Screen/Flow>: <one-line description of failure>`
Example: `[MC] Deploy Flow: app hangs after saving credentials`

**Description**:

```
## What happened
<observed behavior in plain language>

## What was expected
<correct behavior>

## Steps to reproduce
1. <CDP action taken>
2. <CDP action taken>
3. ...

## Error evidence
<console errors, uncaught exceptions, IPC error payloads captured via CDP>

## App state
<current route, visible UI state at time of failure>

## Test phase
Systematic | Adversarial

## Run ID
mc-qa-YYYYMMDD-HHMMSS
```

**Labels**: `automated-qa`, `mission-control`

**Priority**:
| Severity | Priority |
|---|---|
| Crash / uncaught exception | Urgent |
| Broken primary flow | High |
| Stuck state / no feedback | Medium |
| Inconsistent UI | Medium |

**Screenshot**: Attached as Base64 image captured via CDP `Page.captureScreenshot` at moment of failure.

#### End-of-run summary

Print to terminal:
```
MC QA Run mc-qa-YYYYMMDD-HHMMSS complete
─────────────────────────────────────────
Findings:     X functional failures
New tickets:  Y created in Linear (Dash team)
Duplicates:   Z commented on existing issues
```

---

## Key Constraints

1. **Dev mode only** — the skill targets `npm run mc:dev`, not a packaged build. CDP remote debugging port is available in dev mode; it is not in a notarized macOS app.
2. **Functional failures only** — the skill files issues for broken behavior, not visual regressions or performance problems
3. **One ticket per distinct failure** — deduplication is by route + failure type prefix, not by exact error hash, to avoid filing near-duplicate tickets for the same underlying bug
4. **Linear MCP, not raw HTTP** — all Linear interactions go through the provided MCP tools (`mcp__linear-server__*`), never raw fetch calls
5. **Non-destructive** — the skill must not start, stop, or modify real deployed agents beyond what is needed to test the UI. It operates on test/dummy data only.

---

## Success Criteria

- All routes in `src/renderer/src/routes/` visited and primary flows exercised
- All findings have a corresponding Linear issue or comment in the Dash team
- Zero duplicate Linear tickets for the same bug from consecutive runs
- Skill runs to completion without requiring human intervention mid-session

---

## Out of Scope (Future)

- Packaged app testing (would require a different CDP attachment strategy)
- Visual regression screenshots as baseline comparisons
- Automated PR comments linking QA run results
- Scheduled/CI-triggered runs
