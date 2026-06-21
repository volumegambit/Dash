# Mission Control Skills Admin — Design

- **Date:** 2026-06-21
- **Status:** Approved (design)
- **Scope:** A full skills-management surface in the Mission Control desktop app — view, read, edit, create, install, remove an agent's skills, plus a skills-config editor — backed by new gateway HTTP routes.

## 1. Context

The skills *engine* and the chat surface already shipped (`docs/superpowers/specs/2026-06-20-dash-skills-design.md`, merged in PR #40): a bundled `@dash/skills` library, `discoverSkills()`, the `install_skill`/`remove_skill`/`create_skill`/`load_skill` agent tools, and `coordinator.listSkills(id)`.

Mapping the codebase surfaced that **Mission Control already has half a skills feature wired to nothing**:

- **Preload** (`apps/mission-control/src/preload/index.ts`) exposes `skillsList`, `skillsGet`, `skillsUpdateContent`, `skillsCreate`, `skillsGetConfig`, `skillsUpdateConfig`.
- **Main IPC** (`apps/mission-control/src/main/ipc.ts`) registers `skills:list/get/updateContent/create/getConfig/updateConfig`, calling a `ManagementClient`.
- **`ManagementClient`** (`packages/management/src/client.ts`) has `skills()`, `skill()`, `updateSkillContent()`, `createSkill()`, `skillsConfig()`, `updateSkillsConfig()`.
- **But the gateway HTTP routes those call do not exist** — there are zero `…/skills` route registrations in `apps/gateway/src`.
- **And there is no Skills tab** in the agent detail UI (`routes/agents/$id.tsx` has Overview / Configuration / Channels).

So the gap is: implement the gateway routes, revive/extend the client, and build the UI. The data source — `coordinator.listSkills(id)` returning `SkillDiscoveryResult[]` with full content — is ready.

## 2. Locked decisions

| Decision | Choice |
|---|---|
| Scope | Full admin: view, read, **edit**, **create**, install, remove, **+ config editor** |
| MC install security | **Same fail-closed heuristic scan** as the chat path; dangerous skills refused, no operator override (v1) |
| Create vs install | `POST /agents/:id/skills` = create (`{name, description, content}`); `POST /agents/:id/skills/install` = install (`{source, name?}`) |
| Bundled skills | Read-only: edit and remove refused |
| Edit semantics | Replaces the body, preserving `name`/`description` frontmatter |
| Config editing | A registry patch of the agent's `skills.paths` / `skills.includeBundled` (in `agents.json`), not the managed dir |

## 3. Goals & non-goals

**Goals**
- Operators can fully manage an agent's skills from MC without touching the filesystem or chat.
- Reuse the existing install/remove/create logic (no duplication between chat tools and the management API).
- Connect the already-scaffolded MC plumbing to real routes.

**Non-goals**
- No operator override of a dangerous-scan verdict (v1).
- No LLM scanner (still heuristic — tracked separately).
- No skill marketplace/browse UI; install is still by explicit source.
- No bulk operations.

## 4. Architecture

### 4.1 Reusable core (`@dash/agent` skills module)

Extract the install/remove/create/update logic out of the tool factories into pure functions so both the chat tools and the gateway routes share one implementation:

- `createSkill({ managedDir, name, description, content, ...frontmatter }): Promise<SkillWriteResult>`
- `updateSkillContent({ managedDir, name, body }): Promise<SkillWriteResult>` — rewrites the body, preserving frontmatter; errors if the skill is not in the managed dir.
- `installSkill({ managedDir, source, name?, scanner }): Promise<InstallResult>` — `parseSkillSource` → `fetchSkill` → scan (fail-closed) → write `.source=remote`.
- `removeSkill({ managedDir, name, listFn }): Promise<RemoveResult>` — refuses `bundled`; deletes the managed entry.

`createInstallSkillTool` / `createRemoveSkillTool` / `createCreateSkillTool` become thin wrappers over these, returning `AgentToolResult`. Existing tool tests continue to pass (they now exercise the shared core).

### 4.2 Coordinator methods (`apps/gateway/src/agent-chat-coordinator.ts`)

Symmetric with the existing `listSkills(agentId)`, each resolves the agent's managed dir via the existing `managedSkillsDir(config)` option and calls the core:

- `getSkill(agentId, name): Promise<SkillDiscoveryResult | null>`
- `createSkill(agentId, { name, description, content }): Promise<…>`
- `updateSkillContent(agentId, name, body): Promise<…>`
- `installSkill(agentId, source, name?): Promise<…>` — builds the default heuristic scanner.
- `removeSkill(agentId, name): Promise<…>`

Config get/set is a **registry** concern, handled in the route (read `entry.config.skills`; patch + `registry.save()`), mirroring how `mcpServers` config is patched.

### 4.3 Gateway routes (`apps/gateway/src/management-api.ts`)

All under the existing bearer-token auth, returning `404` for unknown agent ids:

| Route | Handler |
|---|---|
| `GET /agents/:id/skills` | `agents.listSkills(id)` |
| `GET /agents/:id/skills/:name` | `agents.getSkill(id, name)` → 404 if absent |
| `POST /agents/:id/skills` | `agents.createSkill(id, body)` |
| `PUT /agents/:id/skills/:name` | `agents.updateSkillContent(id, name, body.content)` → 4xx if bundled/not-found |
| `DELETE /agents/:id/skills/:name` | `agents.removeSkill(id, name)` → 4xx if bundled |
| `POST /agents/:id/skills/install` | `agents.installSkill(id, body.source, body.name)` → 4xx if dangerous |
| `GET /agents/:id/skills/config` | `registry.get(id).config.skills ?? {}` |
| `PATCH /agents/:id/skills/config` | patch `skills.paths` / `skills.includeBundled` + `registry.save()` |

Refusals (bundled edit/remove, dangerous install, missing skill) return a 4xx with a `{ error }` body the UI surfaces.

### 4.4 Management client + types (`packages/management`)

- Widen `SkillInfo` to match `SkillDiscoveryResult`: `source: 'managed' | 'agent' | 'remote' | 'bundled'`, add `trigger?`. `SkillContent` keeps `content`.
- Existing methods (`skills`, `skill`, `createSkill`, `updateSkillContent`, `skillsConfig`, `updateSkillsConfig`) now hit real routes.
- Add `installSkill(agentId, source, name?)` and `removeSkill(agentId, name)`.
- Routes are keyed by agent **id** (matching gateway route params and MC's fetched agent id); MC passes the id.

### 4.5 Mission Control

- **IPC/preload:** add `skills:install` / `skills:remove` handlers + `skillsInstall` / `skillsRemove` preload bridges (the rest already exist).
- **Store:** `useAgentSkills` Zustand store (mirrors `useConnectorsStore`): `load(id)`, `create`, `edit`, `install`, `remove`, `loadConfig`, `saveConfig`, with `loading`/`error`.
- **UI — new Skills tab** in `routes/agents/$id.tsx` (add `'skills'` to `TabId`, the TABS array, and the conditional renderer). A `SkillsTab` component modeled on `connectors.tsx`'s card list:
  - Skill cards: name + description + **source badge** (Bundled / Managed / Agent / Remote); **Edit** / **Remove** on editable (non-bundled) skills.
  - Click a card → read its `SKILL.md` (read-only); **Edit** opens an inline editor (save → `PUT`).
  - **+ Create** (name / description / content) and **+ Install** (source field, optional name) actions.
  - A **Skills settings** strip: `includeBundled` toggle and extra `paths` editor (→ config PATCH).

## 5. Error handling

- Gateway: `404` for unknown agent / skill; `4xx` `{ error }` for bundled edit/remove, dangerous install, invalid name, duplicate create. Internal errors → `500 { error }`.
- Core functions throw typed errors; the gateway maps them to status codes; the coordinator propagates.
- MC store catches and surfaces `error`; the UI shows inline messages (refusal reasons included).

## 6. Testing

- **Core (`@dash/agent`)**: direct tests for `createSkill` / `updateSkillContent` / `installSkill` / `removeSkill` (the existing tool tests keep passing via the wrappers).
- **Gateway** (`management-api-server.test.ts`): add `listSkills/getSkill/createSkill/updateSkillContent/installSkill/removeSkill` to the `makeAgents` coordinator mock; a suite per route covering success + `404` + bundled-refused + dangerous-refused + config get/patch.
- **Coordinator** (`agent-chat-coordinator.test.ts`, CI-run): tests for the new methods.
- **Management client**: round-trip tests against a mock server if the package has them; otherwise type-level.
- **MC store**: a `useAgentSkills` unit test (light, given the renderer/undici constraints).

## 7. Integration points (verified, file:line)

- Gateway routes: `apps/gateway/src/management-api.ts` — agent routes ~300–392; `agents` coordinator + `agentRegistry` destructured at ~109.
- Coordinator: `apps/gateway/src/agent-chat-coordinator.ts` — `listSkills` + `managedSkillsDir` option.
- Core: `packages/agent/src/skills/{tools,install,security}.ts`.
- `SkillDiscoveryResult`: `packages/agent/src/skills/types.ts:13`.
- Client + types: `packages/management/src/client.ts:109`, `packages/management/src/types.ts:30`.
- MC IPC: `apps/mission-control/src/main/ipc.ts:657`; preload `apps/mission-control/src/preload/index.ts:81`.
- MC UI: `apps/mission-control/src/renderer/src/routes/agents/$id.tsx` — `TabId` (~20), `TABS` (~140), renderer (~272); list model `routes/connectors.tsx`; store model `stores/connectors.ts`.

## 8. References

- Prior spec: `docs/superpowers/specs/2026-06-20-dash-skills-design.md`
- Prior PR: Dash#40 (skills engine + chat surface)
