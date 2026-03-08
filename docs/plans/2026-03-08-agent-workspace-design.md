# Agent Workspace Design

**Date:** 2026-03-08

## Problem

Every agent deployed through Mission Control should have a dedicated workspace directory — a sandboxed area of the filesystem where the agent's file tools operate. The workspace infrastructure already exists in the runtime (tool sandboxing via `read_file`, `write_file`, `list_directory`), but the creation-time plumbing is missing: the deploy wizard has no workspace field, the IPC handler doesn't set one, and `process.ts` drops the field when building agent configs.

## Goals

- Every deployed agent gets a workspace directory at deploy time.
- MC auto-generates a sensible default path; users can override it with a native folder picker.
- The path is stored in the registry and available at removal time.
- On removal, MC asks the user whether to also delete the workspace directory.

## Data Model

Two schema additions:

**`DeployWithConfigOptions`** (`apps/mission-control/src/shared/ipc.ts`):
```ts
workspace?: string; // empty = auto-generate
```

**`AgentDeployment`** (`packages/mc/src/types.ts`):
```ts
workspace?: string; // persisted path, set at deploy time
```

`AgentDeployAgentConfig` already has `workspace?: string` — no change needed there.

## Deploy Flow

In the IPC handler for `deployments:deployWithConfig`:

1. If `workspace` is empty/omitted → generate `~/.mission-control/workspaces/<agent-name>-<deploymentId>/`. The deployment ID is generated at the top of `deploy()` in `process.ts`, so the path can be constructed there.
2. If `workspace` is provided → use the user-supplied path as-is.
3. `mkdir(workspacePath, { recursive: true, mode: 0o700 })` — creates the directory (and any missing parents). Mode `0o700` restricts access to the current user on Unix; silently ignored on Windows where home-directory ACLs already enforce the same restriction.
4. Write the path into the agent config JSON file under the temp deploy dir.
5. Store the path in the registry entry as `workspace`.

`process.ts deploy()` currently drops the `workspace` field when building `agentConfigs` — add it alongside `model`, `systemPrompt`, and `tools`.

## Deploy UI (Agent Step)

Add a **Workspace** row to the agent configuration step, below the tools checkboxes:

- A read-only text input showing the selected path, with placeholder `Auto-generated`.
- A **Browse…** button that calls a new `dialog:openDirectory` IPC handler, which triggers `dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })` and returns the selected path.
- A **Clear** (×) button to reset back to auto-generate.

If the user never picks a folder, the field stays empty and auto-generation happens server-side. No client-side path validation — errors from `mkdir` propagate back to the renderer via the existing error handling path.

### New IPC handler

```ts
ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});
```

## Removal Flow

When the user removes a deployment:

1. The renderer reads `deployment.workspace` from the already-loaded deployments list.
2. A confirmation modal appears:
   - If `workspace` is set: includes a checkbox **"Also delete workspace at `<path>`"** (unchecked by default — deletion is opt-in).
   - If `workspace` is not set (pre-feature deployments): simple confirm with no checkbox.
3. On confirm, the renderer calls `deploymentsRemove(id, deleteWorkspace)`.
4. The IPC handler reads the `workspace` path from the registry entry, deletes the directory with `rm -rf` if `deleteWorkspace` is true, then calls `runtime.remove(id)`.

`deploymentsRemove` signature change:
```ts
deploymentsRemove(id: string, deleteWorkspace?: boolean): Promise<void>
```

## Permissions

| Platform | Mechanism | Mode |
|---|---|---|
| macOS / Linux | Unix permission bits | `0o700` (owner rwx, no group/others) |
| Windows | Home-directory ACLs (default) | `mode` option ignored by Node.js |

`0o700` applies to the workspace root only. Files written inside by the agent inherit the process umask. This is acceptable — the directory-level restriction is the meaningful access barrier.

## Files to Change

| File | Change |
|---|---|
| `packages/mc/src/types.ts` | Add `workspace?: string` to `AgentDeployment` |
| `apps/mission-control/src/shared/ipc.ts` | Add `workspace?: string` to `DeployWithConfigOptions`; add `dialog:openDirectory` to API type; update `deploymentsRemove` signature |
| `apps/mission-control/src/preload/index.ts` | Wire `dialog:openDirectory` and updated `deploymentsRemove` |
| `apps/mission-control/src/main/ipc.ts` | Implement `dialog:openDirectory`; generate/use workspace in deploy handler; delete workspace in remove handler |
| `packages/mc/src/runtime/process.ts` | Pass `workspace` through when building `agentConfigs`; store `workspace` in registry entry |
| `apps/mission-control/src/renderer/src/routes/deploy.tsx` | Add workspace field with Browse/Clear controls to agent step |
| `apps/mission-control/src/renderer/src/routes/deployments.tsx` | Add workspace deletion checkbox to remove confirmation modal |
