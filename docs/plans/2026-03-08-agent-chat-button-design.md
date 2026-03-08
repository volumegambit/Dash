# Agent Chat Button — Design

**Date:** 2026-03-08
**Status:** Approved

## Overview

Add a "Chat" button to the agent detail page that navigates the user to the `/chat` page with the specific agent pre-selected.

## Approach

URL search params via TanStack Router's `validateSearch`. This is deep-linkable, survives refresh, and is idiomatic for TanStack Router.

## Changes

### 1. `apps/mission-control/src/renderer/src/routes/agents/$id.tsx`

- Import `MessageSquare` from lucide-react
- Add a "Chat" button to the header action row, visible only when `isRunning === true`
- Button navigates to `/chat` with `search: { deploymentId: id, agentName }`
- `agentName` is derived from the first key of `deployment.config.agents` (same logic as `agentConfig`)
- Button style: same border/muted style as the existing Stop button

### 2. `apps/mission-control/src/renderer/src/routes/chat.tsx`

- Add `validateSearch` to the route definition:
  ```ts
  validateSearch: (search) => ({
    deploymentId: (search.deploymentId as string) ?? '',
    agentName: (search.agentName as string) ?? '',
  })
  ```
- Read search params via `Route.useSearch()`
- Update the auto-select `useEffect` hooks:
  - If `search.deploymentId` is present → use it as the initial `selectedDeploymentId`
  - If `search.agentName` is present → use it as the initial `selectedAgentName`
  - Otherwise → fall back to existing auto-select-first behavior

## Constraints

- Button only shown when agent status is `running`
- No new stores, components, or routes
- No auto-creation of conversations — user lands on chat page with agent pre-selected and clicks "New conversation" themselves
