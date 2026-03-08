# Remove Deploy Entry from Mission Control Sidebar

**Date:** 2026-03-08
**Branch:** worktree-agent-sdk-improvement
**Status:** Approved design, ready for implementation

---

## Decision

Remove the Deploy nav entry from the Mission Control sidebar. The Agents page (`/agents`) already exposes two deploy entry points — a primary "Deploy" button in the header and an empty-state "Deploy your first agent" link — both routing to `/deploy`. The sidebar entry is redundant.

## Change

**File:** `apps/mission-control/src/renderer/src/components/Sidebar.tsx`

- Remove `{ to: '/deploy', label: 'Deploy', icon: Rocket }` from `navItems`
- Remove the unused `Rocket` import from `lucide-react`

## Scope

Nothing else changes. The `/deploy` route, deploy wizard (3-step flow), IPC handlers, Zustand deployments store, and ProcessRuntime are all untouched. Users reach the deploy wizard from the Agents page, which is the correct contextual entry point.

## Testing

- Sidebar renders 5 items (Dashboard, Chat, Agents, Secrets, Settings) with no Deploy entry
- Navigating to `/agents` shows the Deploy button in the page header
- Clicking that Deploy button navigates correctly to `/deploy` wizard
