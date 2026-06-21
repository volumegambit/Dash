# Mission Control Skills Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full skills-management surface in Mission Control — view, read, edit, create, install, remove an agent's skills plus a config editor — backed by new gateway HTTP routes and a shared `@dash/agent` core.

**Architecture:** Extract install/create/update/remove logic from the chat tool factories into pure `@dash/agent` functions that throw typed `SkillOpError`s; expose them via symmetric `AgentChatCoordinator` methods; surface 8 Hono routes on the gateway management API; widen `@dash/management` types + client; connect MC's already-scaffolded IPC/preload and add a Skills tab.

**Tech Stack:** Node 22 ESM, TypeScript strict, tsup, Vitest, TypeBox, Hono, Electron, React, TanStack Router, Zustand, Biome.

## Global Constraints

- ESM only; local imports use `.js` extensions. Biome: 2-space, single quotes, semicolons, 100-col.
- Skills are text-only (scripts stripped on install). MC install uses the **same fail-closed heuristic scan**; dangerous → refused, no override.
- Bundled skills are read-only: edit and remove refused.
- Create = `POST /agents/:id/skills` `{name,description,content}`; install = `POST /agents/:id/skills/install` `{source,name?}`.
- Gateway routes are keyed by agent **id**; bearer-token auth applies; unknown agent → 404.
- Don't mock the Anthropic SDK; tests use temp dirs. Spec: `docs/superpowers/specs/2026-06-21-mc-skills-admin-design.md`.

---

## File Structure

- `packages/agent/src/skills/manage.ts` *(new)* — `SkillOpError` + core ops `createSkillInDir` / `updateSkillBody` / `installSkillToDir` / `removeSkillFromDir`.
- `packages/agent/src/skills/manage.test.ts` *(new)* — core op tests.
- `packages/agent/src/skills/tools.ts` — refactor the three tools to wrap the core ops.
- `packages/agent/src/skills/index.ts` — export the core ops + error.
- `apps/gateway/src/agent-chat-coordinator.ts` — add `getSkill/createSkill/updateSkillContent/installSkill/removeSkill`.
- `apps/gateway/src/management-api.ts` — add 8 skills routes.
- `apps/gateway/src/management-api-server.test.ts` — coordinator mock + route tests.
- `packages/management/src/types.ts` — widen `SkillInfo`.
- `packages/management/src/client.ts` — add `installSkill` / `removeSkill`.
- `apps/mission-control/src/main/ipc.ts` — add `skills:install` / `skills:remove`.
- `apps/mission-control/src/preload/index.ts` (+ `index.d.ts` if present) — add `skillsInstall` / `skillsRemove`.
- `apps/mission-control/src/renderer/src/stores/agent-skills.ts` *(new)* — `useAgentSkills` store.
- `apps/mission-control/src/renderer/src/routes/agents/-components/SkillsTab.tsx` *(new)* — the tab UI.
- `apps/mission-control/src/renderer/src/routes/agents/$id.tsx` — register the tab.
- `apps/mission-control/TEST_PLAN.md` — extend Section 28.

---

## Task 1: Core skill ops (`manage.ts`)

**Files:** Create `packages/agent/src/skills/manage.ts`, `packages/agent/src/skills/manage.test.ts`.

**Interfaces — Produces:**
```ts
export type SkillOpCode = 'not_found' | 'bundled' | 'dangerous' | 'duplicate' | 'invalid' | 'scan_failed';
export class SkillOpError extends Error { code: SkillOpCode; constructor(code: SkillOpCode, message: string); }

export interface InstalledSkill { name: string; location: string; verdict: SkillScanVerdict; }
export interface WrittenSkill { name: string; location: string; }

export function createSkillInDir(o: { managedDir: string; name: string; description: string; content: string }): Promise<WrittenSkill>;
export function updateSkillBody(o: { managedDir: string; name: string; body: string }): Promise<WrittenSkill>;
export function installSkillToDir(o: { managedDir: string; source: string; name?: string; scanner: SkillSecurityScanner }): Promise<InstalledSkill>;
export function removeSkillFromDir(o: { managedDir: string; name: string; listFn: () => Promise<SkillDiscoveryResult[]> }): Promise<{ name: string }>;
```
Each throws `SkillOpError` on failure (`duplicate`/`invalid`/`not_found`/`bundled`/`dangerous`/`scan_failed`), else returns the payload.

- [ ] **Step 1: failing tests** — `manage.test.ts` (temp dirs): `createSkillInDir` writes `SKILL.md` + `.source=agent`, returns name; duplicate → throws `duplicate`; bad name → `invalid`. `updateSkillBody` rewrites the body preserving frontmatter `name`/`description`; missing → `not_found`. `installSkillToDir` (local fixture + injected scanner): safe → writes `.source=remote`; dangerous → `dangerous`, nothing written; scanner throws → `scan_failed`; duplicate → `duplicate`. `removeSkillFromDir` deletes managed entry; bundled (listFn returns `source:'bundled'`) → `bundled`; absent → `not_found`.
- [ ] **Step 2: run** `npx vitest run packages/agent/src/skills/manage.test.ts` → FAIL.
- [ ] **Step 3: implement** `manage.ts` — port the existing logic from `tools.ts` (`createCreateSkillTool`, `createInstallSkillTool`, `createRemoveSkillTool`) into these functions; `updateSkillBody` reads the managed skill via `scanSkillsDirectory(managedDir,'managed')`, regenerates with `generateFrontmatter(existing.frontmatter, body)`. Use `isValidSkillName`, `parseSkillSource`, `fetchSkill`, `parseFrontmatter`, `generateFrontmatter`.
- [ ] **Step 4: run** → PASS.
- [ ] **Step 5: export** from `index.ts`; commit.

## Task 2: Refactor tools to wrap core ops

**Files:** Modify `packages/agent/src/skills/tools.ts`. Test: existing `tools.install.test.ts`, `tools.test.ts` must still pass.

**Interfaces — Consumes:** Task 1 core ops + `SkillOpError`.

- [ ] **Step 1:** Rewrite `createInstallSkillTool` / `createRemoveSkillTool` / `createCreateSkillTool` `execute()` bodies to call the core op inside `try/catch`, mapping success + each `SkillOpError.code` to the **same** `textResult` messages the existing tests assert (e.g. `Installed skill "x"`, `Refused to install`, `security scan failed`, `already installed`, `Removed skill`, `bundled skill and cannot be removed`, `not found`). Keep `onChange`/`scanner` params.
- [ ] **Step 2: run** `npx vitest run packages/agent/src/skills` → all PASS (no test changes needed).
- [ ] **Step 3:** `npm run build -w packages/agent`; commit.

## Task 3: Coordinator skill methods

**Files:** Modify `apps/gateway/src/agent-chat-coordinator.ts`. Test: `agent-chat-coordinator.test.ts`.

**Interfaces — Produces** (on `AgentChatCoordinator`):
```ts
getSkill(agentId: string, name: string): Promise<SkillDiscoveryResult | null>;
createSkill(agentId: string, i: { name: string; description: string; content: string }): Promise<WrittenSkill>;
updateSkillContent(agentId: string, name: string, body: string): Promise<WrittenSkill>;
installSkill(agentId: string, source: string, name?: string): Promise<InstalledSkill>;
removeSkill(agentId: string, name: string): Promise<{ name: string }>;
```
Each resolves `managedDir = options.managedSkillsDir?.(entry.config)` (throw `SkillOpError('not_found')` if no agent/dir) and calls the Task 1 core. `installSkill` builds the default scanner `async (c) => heuristicScan(c)`. `getSkill` filters `listSkills(agentId)` by name.

- [ ] **Step 1: failing tests** — extend `agent-chat-coordinator.test.ts` (CI-run): register an agent + temp managed dir via `managedSkillsDir`; `createSkill` then `getSkill` returns it; `installSkill` from a local fixture appears in `listSkills`; `removeSkill` drops it; `removeSkill` of a bundled name throws `bundled`.
- [ ] **Step 2: run** (collection-fails locally on undici; relies on CI) — verify type-check via `npm run build -w apps/gateway`.
- [ ] **Step 3: implement** the 5 methods; import the core ops + `heuristicScan` from `@dash/agent`.
- [ ] **Step 4:** `npm run build -w apps/gateway` PASS; commit.

## Task 4: Gateway routes

**Files:** Modify `apps/gateway/src/management-api.ts`. Test: `apps/gateway/src/management-api-server.test.ts`.

**Interfaces — Consumes:** `agents` coordinator (Task 3), `agentRegistry`.

Helper: `mapSkillError(err) → { status, body }` (`not_found`→404, `duplicate`→409, `bundled`/`dangerous`/`invalid`/`scan_failed`→422, else 500).

- [ ] **Step 1: failing tests** — add to `makeAgents()` mock: `listSkills/getSkill/createSkill/updateSkillContent/installSkill/removeSkill` (`vi.fn()`). New suites assert: `GET …/skills` → 200 list + 404 unknown agent; `GET …/skills/:name` → 200 + 404 missing; `POST …/skills` → 201; `PUT …/skills/:name` → 200, and 422 when the mock throws `SkillOpError('bundled')`; `DELETE …/skills/:name` → 200, 422 bundled; `POST …/skills/install` → 200, 422 when mock throws `dangerous`; `GET/PATCH …/skills/config` → reads/patches `entry.config.skills`.
- [ ] **Step 2: run** `npx vitest run apps/gateway/src/management-api-server.test.ts` → FAIL.
- [ ] **Step 3: implement** the 8 routes after the existing agent routes (~line 392), each `agentRegistry.get(id)` guard + `try { … } catch (e) { const m = mapSkillError(e); return c.json(m.body, m.status); }`. Config routes mutate `entry.config.skills` and `await agentRegistry.save()`.
- [ ] **Step 4: run** → PASS; commit.

## Task 5: Management client + types

**Files:** Modify `packages/management/src/types.ts`, `packages/management/src/client.ts`.

**Interfaces — Produces:**
```ts
// types.ts: widen
export interface SkillInfo { name: string; description: string; trigger?: string; location: string; content?: string; editable: boolean; source: 'managed'|'agent'|'remote'|'bundled'; }
// client.ts: add
installSkill(agentId: string, source: string, name?: string): Promise<SkillInfo>;
removeSkill(agentId: string, name: string): Promise<void>;
```

- [ ] **Step 1:** Widen `SkillInfo` (`source` enum + `'bundled'`, add `trigger?`; keep `SkillContent extends SkillInfo`). Add `installSkill` (POST `/agents/:id/skills/install` `{source,name}`) and `removeSkill` (DELETE `/agents/:id/skills/:name`).
- [ ] **Step 2:** `npm run build -w packages/management` PASS; commit. (No behavior tests in this package beyond type-check unless a mock-server test exists.)

## Task 6: MC IPC + preload

**Files:** Modify `apps/mission-control/src/main/ipc.ts`, `apps/mission-control/src/preload/index.ts` (+ the `Window['api']` type decl if separate).

- [ ] **Step 1:** Add IPC handlers `skills:install` → `(await getSkillsClient()).installSkill(agentId, source, name)` and `skills:remove` → `.removeSkill(agentId, name)`, mirroring the existing `skills:*` handlers' error pattern.
- [ ] **Step 2:** Add preload bridges `skillsInstall(agentId, source, name?)` and `skillsRemove(agentId, name)`; update the api type declaration.
- [ ] **Step 3:** `npm run typecheck --workspace=apps/mission-control` PASS; commit.

## Task 7: MC Skills tab

**Files:** Create `apps/mission-control/src/renderer/src/stores/agent-skills.ts`, `…/routes/agents/-components/SkillsTab.tsx`; modify `…/routes/agents/$id.tsx`.

**Interfaces — Consumes:** `window.api.skillsList/skillsGet/skillsCreate/skillsUpdateContent/skillsInstall/skillsRemove/skillsGetConfig/skillsUpdateConfig`.

- [ ] **Step 1: store** — `useAgentSkills` (mirror `stores/connectors.ts`): state `{ skills, config, loading, error }`; actions `load(id)`, `create(id,{name,description,content})`, `edit(id,name,body)`, `install(id,source,name?)`, `remove(id,name)`, `loadConfig(id)`, `saveConfig(id,cfg)` — each calls the matching `window.api.*`, refreshes `skills`, and sets `error` on throw.
- [ ] **Step 2: SkillsTab** — modeled on `routes/connectors.tsx`: a `space-y-3` list of skill cards (name + description + a source badge `Bundled|Managed|Agent|Remote` styled like the connector transport pill). Editable (non-`bundled`) cards show **Edit** + **Remove**. Clicking a card expands its `content` (read-only `<pre>`); **Edit** swaps in a `<textarea>` + Save. A header row with **+ Create** and **+ Install** opening small inline forms (Create: name/description/content; Install: source + optional name; show `error` inline incl. refusal text). A **Skills settings** row: `includeBundled` checkbox + a comma/line list editor for `paths`, saved via `saveConfig`.
- [ ] **Step 3: register tab** in `$id.tsx`: add `'skills'` to `TabId`, `{ id: 'skills', label: 'Skills' }` to `TABS`, and `{activeTab === 'skills' && <SkillsTab agentId={agent.id} />}` in the renderer.
- [ ] **Step 4:** `npm run typecheck --workspace=apps/mission-control` PASS; build MC renderer; commit.

## Task 8: Docs, QA, final checks

**Files:** Modify `docs/skills.mdx` (note the MC Skills tab now exists), `apps/mission-control/TEST_PLAN.md` (extend Section 28 with MC tab steps: view/read/edit/create/install/remove/config).

- [ ] **Step 1:** Update docs + TEST_PLAN.
- [ ] **Step 2:** `npm run lint && npm run build && npm test` — all green (the pre-existing undici collection failures excepted). Commit.
- [ ] **Step 3:** Open PR against `main`.

---

## Self-Review

**Spec coverage:** 8 routes (Task 4) ✓; core extraction + DRY tools (Tasks 1–2) ✓; coordinator methods (Task 3) ✓; client+types (Task 5) ✓; MC IPC (Task 6) ✓; MC Skills tab incl. edit/create/install/remove/config (Task 7) ✓; same fail-closed scan (Task 1 `installSkillToDir` + Task 3 default scanner) ✓; bundled read-only (Tasks 1,3,4,7) ✓; create-vs-install split (Task 4) ✓; docs+QA (Task 8) ✓.

**Placeholder scan:** UI step (Task 7) is spec-level prose rather than full JSX — intentional for the repetitive/visual renderer work, mirroring existing `connectors.tsx`; all engine/route/client steps carry concrete signatures + commands.

**Type consistency:** `SkillOpError`/`SkillOpCode`, `InstalledSkill`/`WrittenSkill`, `createSkillInDir`/`updateSkillBody`/`installSkillToDir`/`removeSkillFromDir`, coordinator `getSkill/createSkill/updateSkillContent/installSkill/removeSkill`, client `installSkill/removeSkill`, widened `SkillInfo` — names consistent across tasks.
