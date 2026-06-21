# Dash Skills — Chat-Native Bundled Skill Library & Install Interface

- **Date:** 2026-06-20
- **Status:** Approved (design)
- **Scope:** A bundled multi-domain skill library shipped with Dash, plus a chat-native interface for users to list, trigger, and install `SKILL.md` skills from the public ecosystem.

## 1. Context & motivation

Dash already has a working (but bare) skills *engine*: a `SKILL.md` frontmatter parser, a directory scanner, `load_skill`/`create_skill` tools, and prompt injection of skill metadata via `DashResourceLoader.setExtraSkills()`. What it lacks is (a) a library of ready-made skills, (b) a way to add more skills easily, and (c) any user-facing surface for either.

Ecosystem research (14 agents/products, all findings adversarially verified) established two things:

1. **The whole ecosystem has converged on Anthropic's `SKILL.md` open standard** (now at agentskills.io, ~40 adopters): Anthropic, OpenClaw, Hermes, Kimi, Goose, OpenHands, Gemini CLI, Codex CLI, Cline, and Manus all use the same folder-with-`SKILL.md` primitive Dash already implements. Only Letta/Composio diverge (code-defined tools, no `SKILL.md`). **Dash is already on the winning standard** — the gap is purely library + distribution + UI.
2. **Two of Dash's closest references are near-architectural twins** — OpenClaw (Peter Steinberger; already cited in Dash's plugins spec for its hook dispatcher) and Hermes Agent (Nous Research) are both self-hosted multi-channel messaging gateways with a `SKILL.md` engine, a bundled skill library, and chat-driven install. Their design choices are the highest-signal blueprint.

The convergent "add a skill easily" pattern across the ecosystem is: **one install verb, multiple sources** (`install <slug|git:owner/repo@ref|url|local>`), backed by a registry and gated by install-time security scanning + conservative no-script-on-install loading.

## 2. Locked decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Primary interface | **Chat** (end-users over messaging channels) | Plays to Dash's strength as a messaging gateway; matches Hermes/Kimi. |
| Install permission | **Anyone in chat** (personal-assistant model) | Trusted-audience assumption; install-time scan is the guardrail, not per-user ACLs. |
| Skill sources | **Public ecosystem directly** — explicit `git`/URL/local source | Max reuse of ~150+ public `SKILL.md` skills; no registry to host/maintain. |
| Bundled library | **Broad multi-domain set** (assistant + dev + creative + comms + meta) | Impressive and useful out of the box. |
| Skill execution | **Text-only for v1** (executable scripts stripped) | Makes "anyone can install" defensible — a malicious skill can only inject instructions, not run code. |
| Architecture | **Tools + thin router shim** (Approach A) | Best fit with existing tool/config architecture; deterministic UX for common commands; shippable first slice. |

## 3. Goals & non-goals

**Goals**
- Ship a broad bundled `SKILL.md` library so a fresh Dash agent is immediately more capable.
- Let users list (`/skills`), trigger (`/skill:<name>`), and install ("add the arxiv skill from `NousResearch/hermes-agent`") skills entirely over chat.
- Install from explicit public sources (`git`/URL/local), gated by an install-time security scan.
- Keep the change surface small by reusing the existing engine.

**Non-goals (deferred)**
- Executable/scripted skills (text-only v1). Full scripted document skills (Anthropic-style `pdf`/`docx`/`pptx` with Python) are a **future scripted-skills tier** that rides on the plugins spec's sandboxing.
- A curated Dash registry / friendly-name index.
- Per-user install permissions / role gating.
- A Mission Control skills-management page (chat-first; MC only exposes the tool toggles in the deploy wizard).
- Progressive-disclosure loading levels, frontmatter capability-gating, plugin-style manifests, staging/approval workflow — all deferred to the **plugins spec** where they already belong.

## 4. Architecture: three skill tiers, merged by precedence

Skills resolve from three sources, merged in `listSkills()` (first-wins by name — the existing code already de-dups this way):

1. **Per-agent managed** — `<dataDir>/skills/<agent-name>/` (`source: managed | agent | remote`). Where `create_skill` and the new `install_skill` write.
2. **Per-agent configured paths** — `config.skills.paths[]` (existing).
3. **Bundled** *(new)* — a read-only `@dash/skills` package shipped in the box (`source: bundled`).

**Precedence: per-agent overrides bundled** (a user can shadow a bundled skill by installing one with the same name). Implemented by scanning the bundled tier *last* into the existing name-dedup loop in `listSkills()`.

```
listSkills():
  results = []
  scan(managedSkillsDir, 'managed'|'agent'|'remote')   // existing
  scan(config.skills.paths[], 'managed')               // existing
  if config.skills.includeBundled !== false:
    scan(getBundledSkillsDir(), 'bundled')             // NEW (appended, name-deduped)
  return results
```

## 5. Components

### 5.1 Bundled library package — `packages/skills` (`@dash/skills`)
- Ships real `SKILL.md` files under `packages/skills/skills/<suite>/<name>/SKILL.md` (keeps everything file-based and consistent with the scanner; skills remain forkable/standard).
- Exports `getBundledSkillsDir(): string` resolving to the shipped skills directory (relative to the package, so it works from source and from `dist`).
- Build config must include the `skills/**` `SKILL.md` files in the published package.

### 5.2 Chat command surface (the two halves of Approach A)

**Deterministic half — router shim** in `MessageRouter.handleMessage()`, inserted **before** `agent.chat()` (`packages/channels/src/router.ts:126`). Intercepts only a *known* command set; anything else falls through to the LLM unchanged. The shim is wrapped in try/catch and **falls through to the agent on any error** (a shim bug can never break normal messaging):
- `/skills` → calls `agent.listSkills()` (new passthrough to `backend.listSkills()`); replies with the name + description list directly. No model round-trip.
- `/skill:<name> <args>` (and `/skill <name> <args>`) → rewrites to a normal `agent.chat()` turn: *"Load and apply the skill '<name>'. Input: <args>"*. Deterministic invocation; model executes via `load_skill`.
- `/help` → lists available commands.
- Any other `/…` → passed through to the LLM unchanged.

**Model-driven half — new tools** in `packages/agent/src/skills/tools.ts`, gated in `PiAgentBackend.buildCustomTools()`:
- `install_skill` — natural-language install (e.g. "add the arxiv skill from NousResearch/hermes-agent").
- `remove_skill` — uninstall a managed/remote/agent skill. Bundled skills are read-only: `remove_skill` refuses them. To stop using one, shadow it with a same-named per-agent skill, or disable the entire bundled tier via `includeBundled: false`. Per-skill disable of bundled skills is out of v1 scope.
- No model-facing `list_skills` tool: the skill index is already injected into the system prompt via `setExtraSkills`, so the model already sees what's available (YAGNI).

### 5.3 Install pipeline + security scan

`install_skill(source, name?)` where `source` ∈ `git:owner/repo[/subpath][@ref]` | `https://…/SKILL.md` | local path:

1. **Fetch** → shallow `git clone --depth 1` to a temp dir (or single-file fetch for URL / copy for local). **Text-only:** copy `SKILL.md` and referenced `.md` files only; **executable scripts are ignored/stripped** in v1.
2. **Scan** → LLM classifier over the `SKILL.md` content (via the agent's existing provider), returning `safe | suspicious | dangerous` for prompt-injection, data-exfiltration, destructive, and credential-harvesting instructions. The model call sits behind an interface so policy is testable without mocking the SDK.
3. **Policy** → `dangerous` = refused (no override in v1); `suspicious` = installed with a warning surfaced in the confirmation; `safe` = installed silently. **Fail-closed:** if the scan cannot complete, refuse.
4. **Write** → `<managedSkillsDir>/<name>/SKILL.md` + `.source` = `remote`; then live re-inject via `setExtraSkills` so the skill is usable immediately.

Reusing this pipeline, `config.skills.urls[]` (declared today but currently unscanned) becomes **declarative provisioning**: any listed source not already present is pre-installed at agent boot.

## 6. Data model, config & MC surface

- `SkillDiscoveryResult.source` (`packages/agent/src/skills/types.ts`): add `'bundled'`.
- `scanSkillsDirectory(dirPath, defaultSource)`: widen `defaultSource` to include `'bundled'`.
- `DashAgentConfig.skills` and `GatewayAgentConfig.skills`: add `includeBundled?: boolean` (default `true`).
- `packages/agent/src/backends/piagent.ts`:
  - `buildCustomTools()` — register `install_skill` / `remove_skill` behind `allowedNames`.
  - `listSkills()` — append the bundled tier (name-deduped) unless `includeBundled === false`.
- `apps/mission-control/src/renderer/src/components/deploy-options.ts` — add `install_skill` / `remove_skill` to `TOOL_DESCRIPTIONS` and the "Skills" `TOOL_GROUPS` entry. **No new MC pages.**
- `DashAgent` — add `listSkills()` passthrough so the router shim can list without invoking the model.

## 7. Bundled skill catalog (15 skills, text-only, orchestrating existing tools)

| Suite | Skill | When to use | Leans on |
|---|---|---|---|
| assistant | `summarize-thread` | Condense a long conversation/doc into points, decisions, open questions | text |
| assistant | `draft-reply` | Draft a reply matching the user's tone for a thread | text |
| assistant | `deep-research` | Multi-source web research with cited synthesis | `web_search`, `web_fetch`, `todowrite` |
| assistant | `extract-action-items` | Pull tasks/owners/dates from a transcript into a checklist | `todowrite` |
| assistant | `read-documents` | Answer over / extract from PDFs & Office files a user shares | `bash`, `read` |
| dev | `code-review` | Review a diff/PR for correctness, security, clarity | `bash`(git), `read`, `grep` |
| dev | `systematic-debugging` | Disciplined root-cause workflow for a bug/failure | `bash`, `read`, `grep` |
| dev | `pr-workflow` | Branch → commit → open a well-described PR | `bash`(git/gh), `projects_*` |
| dev | `write-tests` | Author focused tests for given code | `read`, `write`, `bash` |
| creative | `make-diagram` | Produce a Mermaid/ASCII diagram from a description | text |
| creative | `slide-outline` | Structure a deck outline (sections, slide-by-slide) | text |
| creative | `rewrite-polish` | Improve clarity/concision/tone of writing | text |
| comms | `brand-voice` | Apply a defined brand voice to drafts | `read` (brand doc) |
| comms | `announcement` | Draft launch/update/incident announcements | text |
| meta | `manage-skills` | How to find/install/remove/author skills + pointers to the public ecosystem | `install_skill`, `create_skill` |

`manage-skills` is the keystone for the "easily add more" goal: it teaches the agent (and through it, the user) how to pull from `anthropics/skills`, `openai/skills`, `NousResearch/hermes-agent`, and `openclaw/agent-skills`.

**Known limitation:** because v1 strips executable scripts, script-bearing public skills (e.g. Anthropic's `pdf`/`docx`/`pptx`, which ship Python) won't fully work. `read-documents` and `slide-outline` therefore operate via `bash` + whatever libraries exist, or are outline/text-only. Full scripted document skills are a future scripted-skills tier.

## 8. Error handling (follows existing Dash conventions)

- Tools return error text in `AgentToolResult` (never throw): invalid source, fetch failure, duplicate name, scan-blocked, scan-unavailable.
- Router shim wrapped in try/catch → falls through to the agent on any unexpected error.
- Unknown `/commands` pass through to the LLM rather than erroring.
- Security scan failure → fail-closed (refuse install).

## 9. Testing

- **Unit (vitest + temp dirs):**
  - scanner `bundled` source tier.
  - `listSkills` precedence (per-agent shadows bundled).
  - `install_skill`: local copy + `.source=remote`; name validation; duplicate handling; script-stripping; scan-block via injected classifier returning `dangerous`; fail-closed on scan error.
  - `git:owner/repo/subpath@ref` source parsing.
  - `remove_skill`: deletes a managed entry, refuses bundled.
  - router shim: `/skills` lists, `/skill:name` rewrites, unknown `/x` passes through, shim error falls through.
- **Bundled-library integrity test:** every bundled `SKILL.md` parses, name matches its dir, description present.
- **Security classifier:** model call behind an interface so policy/parsing is tested deterministically (per CLAUDE.md — don't mock the Anthropic SDK).
- **Manual QA:** new `apps/mission-control/TEST_PLAN.md` section for skills-over-chat.

## 10. Build order (four independently-shippable slices)

1. **Bundled tier** — `@dash/skills` package + catalog, `'bundled'` source, `listSkills` merge, `includeBundled` config. *(Smart out of the box.)*
2. **Install engine** — `install_skill` + `remove_skill` + fetch + security scan + live re-inject. *(Add-easily engine.)*
3. **Router shim** — `/skills`, `/skill:<name>`, `/help` + `agent.listSkills` passthrough. *(Chat UX.)*
4. **Wiring + docs** — MC deploy-options toggles, config plumbing, user docs, TEST_PLAN section.

## 11. Integration points (verified, file:line)

- Router intercept: `packages/channels/src/router.ts` — `MessageRouter.handleMessage()` (~59–137), before `agent.chat()` at ~126; reply via `adapter.send(conversationId, { text })`. No existing command parsing to conflict with.
- Skill tools: `packages/agent/src/skills/tools.ts` (`createLoadSkillTool`, `createCreateSkillTool`) — add `install_skill`/`remove_skill` creators.
- Tool registration: `packages/agent/src/backends/piagent.ts` — `buildCustomTools()` (~355–474), gated by `allowedNames`; `listSkills()` (~961–985); `listSkillsAsPiSkills()` (~941–956); `setExtraSkills` injection (~553).
- Types/config: `packages/agent/src/skills/types.ts`; `DashAgentConfig` (`packages/agent/src/types.ts` ~64–77); `GatewayAgentConfig` (`apps/gateway/src/agent-registry.ts` ~5–16).
- Managed dir resolution: `apps/gateway/src/index.ts:196` — `resolve(dataDir, 'skills', agentConfig.name)`.
- MC deploy wizard: `apps/mission-control/src/renderer/src/components/deploy-options.ts` — `TOOL_DESCRIPTIONS` (~18–33), `TOOL_GROUPS` "Skills" group (~46–77).

## 12. References

- Anthropic Agent Skills / `SKILL.md` standard: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview · https://github.com/anthropics/skills · https://agentskills.io
- OpenClaw: https://github.com/openclaw/openclaw · https://docs.openclaw.ai/tools/skills
- Hermes Agent (Nous Research): https://github.com/NousResearch/hermes-agent
- Kimi (Moonshot) skills/plugins: https://github.com/MoonshotAI/Kimi-K2
- OpenAI Codex skills: https://github.com/openai/skills
- Related Dash spec: `docs/superpowers/specs/2026-06-10-dash-plugins-design.md` (the trusted in-process plugin tier; the future home for scripted skills, manifests, hooks, and staging/approval).
