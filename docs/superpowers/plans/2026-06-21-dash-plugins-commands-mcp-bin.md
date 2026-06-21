# Dash Plugins — Commands + MCP + bin (Claude Code compat, Plan 2 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route three more Claude Code plugin components into Dash — `commands/*.md` (as invocable skills), `.mcp.json` (as MCP servers), and `bin/` (on the bash PATH) — and enforce the per-plugin `trusted` gate for the two that execute code.

**Architecture:** Extend `@dash/plugins`' loader to discover and (trust-)gate the new components, returning `commandFiles`, `binDirs`, and translated `mcpConfigs` alongside Plan 1's `skillDirs`. A new pure `translateMcpJson` converts Claude's `.mcp.json` object-map to Dash `McpServerConfig[]`. `@dash/agent` gains flat-file skill loading so a `commands/foo.md` becomes a pi `Skill`. The gateway registers trusted plugins' MCP servers (`mcpManager.addServer`), prepends their `bin/` to `process.env.PATH`, and passes command files into the backend. The slash router learns Claude's `/plugin:command` namespacing.

**Tech Stack:** Node.js 22+, ESM, TS strict / ES2024 / NodeNext, tsup, Vitest globals, Biome (2-space, single quotes, semicolons, 100-char). `.js` import extensions.

## Global Constraints

- **Builds on Plan 1** (branch `feat/plugins`). `@dash/plugin-sdk` and `@dash/plugins` exist; the loader currently returns `{ records, skillDirs }`; `manifest.ts` has `readManifest`/`validateManifest`/`resolveSkillDirs` (the latter already contains paths to the plugin root via a `relative`/`isAbsolute` check); the gateway runs `loadPlugins` after MCP setup and merges `skillDirs` into `config.skills.paths`.
- **Trust model (enforced this plan):** `enabled` gates markdown components (skills, commands). `enabled && trusted` gates **code-execution** components (MCP servers, `bin/`). A plugin's `PluginEntryConfig` carries `enabled` and `trusted` (Plan 1). Path-entry plugins (`path:`) are auto-`enabled` but NOT auto-`trusted` — dev plugins must still opt into code execution.
- **Claude Code component contracts (verbatim):**
  - `.mcp.json` at plugin root: `{ "mcpServers": { "<name>": <server> } }`. Stdio server: `{ "command": string, "args"?: string[], "env"?: object, "type"?: "stdio" }`. Remote: `{ "type": "http"|"sse"|"ws", "url": string, "headers"?: object }`. `${VAR}` / `${VAR:-default}` env expansion is deferred to Plan 3 (path vars) — Plan 2 passes values through verbatim.
  - `commands/*.md`: flat markdown files (one command per file). Command name = file basename (no ext); namespaced `<plugin>:<basename>`. Manifest `commands` field REPLACES the default `commands/` scan; relative `./`-prefixed paths only.
  - `bin/`: a directory of executables at the plugin root; prepended to the bash tool's PATH.
- **MCP name rules (from `@dash/mcp`):** server names must match `^[a-zA-Z0-9_-]+$` and must NOT contain `__`. Plugin MCP servers are namespaced `<plugin>__<server>`? NO — `__` is forbidden; namespace with a single hyphen: `<plugin>-<server>` (kebab), and validate.
- **Containment:** every resolved component path (skill dir, command file, bin dir, and any path inside `.mcp.json` that the loader resolves) must stay within the plugin root — reuse Plan 1's containment check.
- **Node:** default v22.9.0 breaks `pi-coding-agent`/undici; use Node 22.23.0 for any pi-importing test (the gateway wiring test, the agent flat-skill test, and the full gate). Pure-logic tests (`translateMcpJson`, loader, slash parser) run on default node.
- **Cross-plan contract:** `LoadedPlugins` grows new fields (`commandFiles`, `binDirs`, `mcpConfigs`) — additive only; Plan 1's `skillDirs` and `records` stay. Plans 3–5 consume these.

---

## File structure

| File | Responsibility |
|------|----------------|
| `packages/plugins/package.json` | Add `@dash/mcp` dependency (for `McpServerConfig` type + name pattern). |
| `packages/plugins/src/mcp-translate.ts` | `translateMcpJson(raw, pluginName)` — Claude `.mcp.json` object → `McpServerConfig[]`. |
| `packages/plugins/src/mcp-translate.test.ts` | Translation + validation tests. |
| `packages/plugins/src/manifest.ts` | Add `resolveCommandFiles`, `resolveBinDir`; extract shared `containedPath` helper (reused by `resolveSkillDirs`). |
| `packages/plugins/src/manifest.test.ts` | Add command/bin resolution tests. |
| `packages/plugins/src/loader.ts` | Discover commands/bin/mcp; trust-gate; extend `LoadedPlugins` + `PluginRecord.activated`. |
| `packages/plugins/src/loader.test.ts` | Add command/bin/mcp + trust-gate tests. |
| `packages/plugins/src/types.ts` | Extend `LoadedPlugins` (commandFiles, binDirs, mcpConfigs). |
| `packages/agent/src/skills/flat.ts` | `loadFlatSkills(files)` — parse flat `.md` → `SkillDiscoveryResult[]`. |
| `packages/agent/src/skills/flat.test.ts` | Flat-skill parsing tests. |
| `packages/agent/src/skills/index.ts` | Export `loadFlatSkills`. |
| `packages/agent/src/index.ts` | Re-export `loadFlatSkills`. |
| `packages/agent/src/backends/piagent.ts` | New optional ctor param `extraSkillFiles`; include flat skills in `listSkills`. |
| `packages/channels/src/commands.ts` | Parse Claude `/plugin:command` namespaced form. |
| `packages/channels/src/commands.test.ts` | Slash parser tests (create if absent). |
| `apps/gateway/src/plugin-mcp.ts` | `registerPluginMcpServers(...)` — translate+register trusted plugins' MCP, fail-isolated. |
| `apps/gateway/src/plugin-mcp.test.ts` | Registration tests. |
| `apps/gateway/src/index.ts` | Wire MCP registration + bin PATH prepend + pass `extraSkillFiles` to backend. |
| `apps/gateway/src/plugins-wiring.test.ts` | Extend: commands discoverable; trusted-only mcp/bin. |
| `docs/configuration.mdx` | Document commands, MCP, bin, and the trust flag. |

---

## Task 1 — `translateMcpJson` (Claude `.mcp.json` → `McpServerConfig[]`)

**Files:**
- Modify: `packages/plugins/package.json` (add `@dash/mcp` dep)
- Create: `packages/plugins/src/mcp-translate.ts`
- Test: `packages/plugins/src/mcp-translate.test.ts`
- Modify: `packages/plugins/src/index.ts` (export)

**Interfaces:**
- Consumes: `McpServerConfig`, `SERVER_NAME_PATTERN`, `NAMESPACE_SEPARATOR` from `@dash/mcp`.
- Produces: `translateMcpJson(raw: unknown, pluginName: string): McpServerConfig[]`.

- [ ] **Step 1: Add the dependency.** In `packages/plugins/package.json` add to `dependencies`: `"@dash/mcp": "*"`. Run `npm install`.

- [ ] **Step 2: Write the failing test** `packages/plugins/src/mcp-translate.test.ts`:

```ts
import { translateMcpJson } from './mcp-translate.js';

describe('translateMcpJson', () => {
  it('translates a stdio server', () => {
    const out = translateMcpJson(
      { mcpServers: { db: { command: 'node', args: ['s.js'], env: { K: 'v' } } } },
      'myplugin',
    );
    expect(out).toEqual([
      {
        name: 'myplugin-db',
        transport: { type: 'stdio', command: 'node', args: ['s.js'] },
        env: { K: 'v' },
      },
    ]);
  });

  it('maps Claude "http" to Dash "streamable-http" and carries headers', () => {
    const out = translateMcpJson(
      { mcpServers: { api: { type: 'http', url: 'https://x/mcp', headers: { A: 'b' } } } },
      'p',
    );
    expect(out[0].transport).toEqual({ type: 'streamable-http', url: 'https://x/mcp', headers: { A: 'b' } });
    expect(out[0].name).toBe('p-api');
  });

  it('passes through sse', () => {
    const out = translateMcpJson({ mcpServers: { s: { type: 'sse', url: 'https://x/sse' } } }, 'p');
    expect(out[0].transport).toEqual({ type: 'sse', url: 'https://x/sse' });
  });

  it('returns [] for missing/empty mcpServers', () => {
    expect(translateMcpJson({}, 'p')).toEqual([]);
    expect(translateMcpJson({ mcpServers: {} }, 'p')).toEqual([]);
    expect(translateMcpJson(null, 'p')).toEqual([]);
  });

  it('throws on a server name that breaks Dash rules after namespacing', () => {
    // server key with "__" would survive into the namespaced name → invalid
    expect(() => translateMcpJson({ mcpServers: { 'a__b': { command: 'x' } } }, 'p')).toThrow(
      /invalid/i,
    );
  });

  it('throws on an unsupported transport type (ws not supported)', () => {
    expect(() => translateMcpJson({ mcpServers: { s: { type: 'ws', url: 'wss://x' } } }, 'p')).toThrow(
      /unsupported|ws/i,
    );
  });

  it('throws on a stdio server missing command', () => {
    expect(() => translateMcpJson({ mcpServers: { s: {} } }, 'p')).toThrow(/command/);
  });
});
```

- [ ] **Step 3: Run it — expect FAIL** (`module missing`): `npx vitest run packages/plugins/src/mcp-translate.test.ts`.

- [ ] **Step 4: Create `packages/plugins/src/mcp-translate.ts`:**

```ts
import {
  NAMESPACE_SEPARATOR,
  SERVER_NAME_PATTERN,
  type McpServerConfig,
  type TransportConfig,
} from '@dash/mcp';

/**
 * Translates a Claude Code `.mcp.json` object (`{ mcpServers: { name: server } }`)
 * into Dash `McpServerConfig[]`. Each server is namespaced `<plugin>-<name>` to
 * avoid cross-plugin collisions, and validated against Dash's MCP name rules.
 * Transport mapping: stdio→stdio, Claude `http`→Dash `streamable-http`, sse→sse.
 * `ws` and unknown types are rejected (Dash has no ws transport). `${VAR}`
 * expansion is intentionally NOT done here (Plan 3 owns path/env substitution).
 */
export function translateMcpJson(raw: unknown, pluginName: string): McpServerConfig[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const servers = (raw as Record<string, unknown>).mcpServers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return [];

  const out: McpServerConfig[] = [];
  for (const [key, value] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`mcp server '${key}' must be an object`);
    }
    const s = value as Record<string, unknown>;
    const name = `${pluginName}-${key}`;
    if (name.includes(NAMESPACE_SEPARATOR) || !SERVER_NAME_PATTERN.test(name)) {
      throw new Error(
        `invalid MCP server name '${name}' (from plugin '${pluginName}', key '${key}') — must match ${SERVER_NAME_PATTERN} and not contain '${NAMESPACE_SEPARATOR}'`,
      );
    }
    out.push({ name, transport: toTransport(s, key), ...(toEnv(s) ? { env: toEnv(s) } : {}) });
  }
  return out;
}

function toTransport(s: Record<string, unknown>, key: string): TransportConfig {
  const type = typeof s.type === 'string' ? s.type : 'stdio';
  if (type === 'stdio') {
    if (typeof s.command !== 'string' || s.command.length === 0) {
      throw new Error(`mcp server '${key}': stdio transport requires a 'command' string`);
    }
    return {
      type: 'stdio',
      command: s.command,
      ...(Array.isArray(s.args) ? { args: s.args as string[] } : {}),
    };
  }
  if (type === 'http' || type === 'streamable-http') {
    requireUrl(s, key);
    return { type: 'streamable-http', url: s.url as string, ...(toHeaders(s) ? { headers: toHeaders(s) } : {}) };
  }
  if (type === 'sse') {
    requireUrl(s, key);
    return { type: 'sse', url: s.url as string, ...(toHeaders(s) ? { headers: toHeaders(s) } : {}) };
  }
  throw new Error(`mcp server '${key}': unsupported transport type '${type}' (supported: stdio, http, sse)`);
}

function requireUrl(s: Record<string, unknown>, key: string): void {
  if (typeof s.url !== 'string' || s.url.length === 0) {
    throw new Error(`mcp server '${key}': remote transport requires a 'url' string`);
  }
}

function toHeaders(s: Record<string, unknown>): Record<string, string> | undefined {
  return isStringRecord(s.headers) ? (s.headers as Record<string, string>) : undefined;
}

function toEnv(s: Record<string, unknown>): Record<string, string> | undefined {
  return isStringRecord(s.env) ? (s.env as Record<string, string>) : undefined;
}

function isStringRecord(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
```

- [ ] **Step 5: Run tests — expect PASS.** `npx vitest run packages/plugins/src/mcp-translate.test.ts`.
- [ ] **Step 6: Export** from `packages/plugins/src/index.ts`: `export { translateMcpJson } from './mcp-translate.js';`
- [ ] **Step 7: Verify + commit.** `npm run build -w packages/mcp -w packages/plugin-sdk -w packages/plugins && npm run typecheck --workspace=packages/plugins`; `npx biome check packages/plugins`.

```bash
git add packages/plugins/package.json packages/plugins/src/mcp-translate.ts \
  packages/plugins/src/mcp-translate.test.ts packages/plugins/src/index.ts package-lock.json
git commit -m "feat(plugins): translate Claude .mcp.json to Dash McpServerConfig"
```

---

## Task 2 — Manifest resolvers for commands + bin (with shared containment)

**Files:**
- Modify: `packages/plugins/src/manifest.ts`
- Modify: `packages/plugins/src/manifest.test.ts`

**Interfaces:**
- Produces: `resolveCommandFiles(dir, manifest): string[]`, `resolveBinDir(dir): string | undefined`, and a shared `containedPath(dir, rel): string | undefined` (returns the absolute path if it exists AND is inside `dir`, else `undefined`).

- [ ] **Step 1: Write failing tests** — append to `packages/plugins/src/manifest.test.ts`:

```ts
describe('resolveCommandFiles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-cmd-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds flat .md files under the default commands/ dir', async () => {
    await mkdir(join(dir, 'commands'), { recursive: true });
    await writeFile(join(dir, 'commands', 'deploy.md'), '# deploy');
    await writeFile(join(dir, 'commands', 'rollback.md'), '# rollback');
    await writeFile(join(dir, 'commands', 'notes.txt'), 'ignore me');
    const files = resolveCommandFiles(dir, { name: 'p' }).sort();
    expect(files).toEqual([join(dir, 'commands', 'deploy.md'), join(dir, 'commands', 'rollback.md')]);
  });

  it('manifest commands REPLACES the default dir', async () => {
    await mkdir(join(dir, 'commands'), { recursive: true });
    await writeFile(join(dir, 'commands', 'default.md'), 'x');
    await mkdir(join(dir, 'custom'), { recursive: true });
    await writeFile(join(dir, 'custom', 'special.md'), 'y');
    const files = resolveCommandFiles(dir, { name: 'p', commands: ['./custom'] });
    expect(files).toEqual([join(dir, 'custom', 'special.md')]);
  });

  it('returns [] when no commands dir exists', () => {
    expect(resolveCommandFiles(dir, { name: 'p' })).toEqual([]);
  });
});

describe('resolveBinDir', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-bin-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the bin/ dir when present, undefined otherwise', async () => {
    expect(resolveBinDir(dir)).toBeUndefined();
    await mkdir(join(dir, 'bin'), { recursive: true });
    expect(resolveBinDir(dir)).toBe(join(dir, 'bin'));
  });
});
```

Also update the import at the top of `manifest.test.ts` to include `resolveCommandFiles, resolveBinDir`.

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run packages/plugins/src/manifest.test.ts`.

- [ ] **Step 3: Edit `packages/plugins/src/manifest.ts`.** Add `readdirSync` to the `node:fs` import and `relative`, `isAbsolute` are already imported (from the Plan 1 containment fix — verify). Add the shared helper and refactor `resolveSkillDirs` to use it, then add the two new resolvers:

```ts
/** Absolute path of `rel` resolved against `dir`, but only if it exists AND stays within `dir`. */
export function containedPath(dir: string, rel: string): string | undefined {
  if (!rel.startsWith('./')) return undefined;
  const abs = resolve(dir, rel);
  const r = relative(dir, abs);
  if (r.startsWith('..') || isAbsolute(r)) return undefined;
  return existsSync(abs) ? abs : undefined;
}

/** Flat `commands/*.md` files. Manifest `commands` REPLACES the default `commands/` scan. */
export function resolveCommandFiles(dir: string, manifest: PluginManifest): string[] {
  const roots = manifest.commands?.length
    ? (manifest.commands.map((p) => containedPath(dir, p)).filter((p): p is string => !!p))
    : (existsSync(join(dir, 'commands')) ? [join(dir, 'commands')] : []);
  const files: string[] = [];
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(root, entry.name));
    }
  }
  return files;
}

/** The plugin's `bin/` dir, if present. */
export function resolveBinDir(dir: string): string | undefined {
  const bin = join(dir, 'bin');
  return existsSync(bin) ? bin : undefined;
}
```

Refactor `resolveSkillDirs` to reuse `containedPath` for its manifest-supplied entries (the default `skills/` dir is always within root). Keep its existing behavior identical (default dir + contained manifest dirs).

- [ ] **Step 4: Run — expect PASS.** `npx vitest run packages/plugins/src/manifest.test.ts`.
- [ ] **Step 5: Export** new functions from `packages/plugins/src/index.ts` (`containedPath`, `resolveCommandFiles`, `resolveBinDir`).
- [ ] **Step 6: Verify + commit.** Build plugins, typecheck, biome.

```bash
git add packages/plugins/src/manifest.ts packages/plugins/src/manifest.test.ts packages/plugins/src/index.ts
git commit -m "feat(plugins): resolve plugin command files and bin dir with containment"
```

---

## Task 3 — Loader: discover + trust-gate commands/bin/mcp

**Files:**
- Modify: `packages/plugins/src/types.ts` (extend `LoadedPlugins`)
- Modify: `packages/plugins/src/loader.ts`
- Modify: `packages/plugins/src/loader.test.ts`

**Interfaces:**
- Consumes: `translateMcpJson` (T1), `resolveCommandFiles`/`resolveBinDir` (T2), `readManifest`/`resolveSkillDirs`.
- Produces: extended `LoadedPlugins` with `commandFiles: string[]`, `binDirs: string[]`, `mcpConfigs: Array<{ pluginName: string; config: McpServerConfig }>`.

- [ ] **Step 1: Extend `LoadedPlugins`** in `packages/plugins/src/types.ts`:

```ts
import type { McpServerConfig } from '@dash/mcp';
// ...
export interface LoadedPlugins {
  records: PluginRecord[];
  /** Skill dirs from enabled plugins (Plan 1). */
  skillDirs: string[];
  /** Flat command .md files from enabled plugins. */
  commandFiles: string[];
  /** bin/ dirs from enabled+trusted plugins (code execution). */
  binDirs: string[];
  /** Translated MCP servers from enabled+trusted plugins, tagged by plugin. */
  mcpConfigs: Array<{ pluginName: string; config: McpServerConfig }>;
}
```

- [ ] **Step 2: Write failing loader tests** — add cases to `packages/plugins/src/loader.test.ts` (extend the existing `writePlugin` helper to optionally write `commands/<name>.md`, a `bin/` dir, and a `.mcp.json`):

```ts
it('collects commands for an enabled plugin (markdown — no trust needed)', async () => {
  const dir = await writePlugin(pluginsDir, 'p', { skill: 'g', command: 'deploy' });
  const loaded = await loadPlugins({ pluginsDir, entries: { p: { enabled: true } } });
  expect(loaded.commandFiles).toEqual([join(dir, 'commands', 'deploy.md')]);
  expect(loaded.records[0].activated).toEqual(expect.arrayContaining(['skills', 'commands']));
});

it('withholds mcp + bin from an enabled-but-untrusted plugin', async () => {
  await writePlugin(pluginsDir, 'p', { mcp: { mcpServers: { db: { command: 'node' } } }, bin: true });
  const loaded = await loadPlugins({ pluginsDir, entries: { p: { enabled: true } } });
  expect(loaded.mcpConfigs).toEqual([]);
  expect(loaded.binDirs).toEqual([]);
  expect(loaded.records[0].noop).toEqual(expect.arrayContaining(['mcp', 'bin']));
});

it('activates mcp + bin for an enabled+trusted plugin', async () => {
  const dir = await writePlugin(pluginsDir, 'p', { mcp: { mcpServers: { db: { command: 'node' } } }, bin: true });
  const loaded = await loadPlugins({ pluginsDir, entries: { p: { enabled: true, trusted: true } } });
  expect(loaded.mcpConfigs).toEqual([{ pluginName: 'p', config: { name: 'p-db', transport: { type: 'stdio', command: 'node' } } }]);
  expect(loaded.binDirs).toEqual([join(dir, 'bin')]);
  expect(loaded.records[0].activated).toEqual(expect.arrayContaining(['mcp', 'bin']));
});

it('records an mcp translation failure without aborting (status error, others load)', async () => {
  await writePlugin(pluginsDir, 'bad', { mcp: { mcpServers: { 's': { type: 'ws', url: 'wss://x' } } } });
  await writePlugin(pluginsDir, 'good', { skill: 'g' });
  const loaded = await loadPlugins({
    pluginsDir,
    entries: { bad: { enabled: true, trusted: true }, good: { enabled: true } },
  });
  const byName = Object.fromEntries(loaded.records.map((r) => [r.name, r]));
  expect(byName.good.status).toBe('loaded');
  expect(byName.bad.status).toBe('error');
});
```

- [ ] **Step 3: Run — expect FAIL.**

- [ ] **Step 4: Update `packages/plugins/src/loader.ts`.** Import the new resolvers + `translateMcpJson` + `readFileSync`/`existsSync`. In the per-plugin enabled branch, after computing `sDirs`, also compute `commandFiles` (enabled), and — only when `entry.trusted` (path-entries included only if their config sets `trusted`) — compute `binDirs` and parse+translate `.mcp.json`. Accumulate into the new `LoadedPlugins` fields. Set `activated`/`noop` per component. Wrap `.mcp.json` parse+translate so a translation throw marks the plugin `error` (phase `'route'`) without aborting. Initialize the three new arrays and return them. Trust source: `const trusted = entry.trusted === true;` (NOT auto-true for path entries — code execution needs explicit trust).

  Pseudostructure for the enabled branch:
  ```ts
  const sDirs = resolveSkillDirs(dir, manifest);
  const cmdFiles = resolveCommandFiles(dir, manifest);
  skillDirs.push(...sDirs);
  commandFiles.push(...cmdFiles);
  const activated: string[] = [];
  const noop: string[] = [];
  if (sDirs.length) activated.push('skills');
  if (cmdFiles.length) activated.push('commands');
  const trusted = entry.trusted === true;
  const binDir = resolveBinDir(dir);
  const mcpPath = join(dir, '.mcp.json');
  const hasMcp = existsSync(mcpPath);
  if (binDir) (trusted ? activated : noop).push('bin');
  if (hasMcp) {
    if (trusted) {
      const raw = JSON.parse(readFileSync(mcpPath, 'utf8'));
      const cfgs = translateMcpJson(raw, manifest.name); // may throw → caught → error record
      for (const config of cfgs) mcpConfigs.push({ pluginName: manifest.name, config });
      if (cfgs.length) activated.push('mcp');
    } else {
      noop.push('mcp');
    }
  }
  if (trusted && binDir) binDirs.push(binDir);
  records.push({ ...recordBase, status: 'loaded', skillDirs: sDirs, activated, noop });
  ```
  (Keep the existing disabled/error branches; on JSON-parse or translate throw, push an `error` record with `failure.phase: 'route'`.)

- [ ] **Step 5: Run — expect PASS** (all loader tests, incl. Plan 1's).
- [ ] **Step 6: Verify + commit.** Build mcp+plugin-sdk+plugins, typecheck, biome.

```bash
git add packages/plugins/src/types.ts packages/plugins/src/loader.ts packages/plugins/src/loader.test.ts
git commit -m "feat(plugins): loader discovers + trust-gates commands, bin, and mcp"
```

---

## Task 4 — `@dash/agent`: flat-file skills + backend `extraSkillFiles`

**Files:**
- Create: `packages/agent/src/skills/flat.ts`
- Test: `packages/agent/src/skills/flat.test.ts`
- Modify: `packages/agent/src/skills/index.ts`, `packages/agent/src/index.ts` (exports)
- Modify: `packages/agent/src/backends/piagent.ts` (new optional ctor param + include in `listSkills`)

**Interfaces:**
- Produces: `loadFlatSkills(files: string[]): Promise<SkillDiscoveryResult[]>`; `PiAgentBackend` accepts `extraSkillFiles?: string[]`.

- [ ] **Step 1: Write failing test** `packages/agent/src/skills/flat.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFlatSkills } from './flat.js';

describe('loadFlatSkills', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flat-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses frontmatter name/description from a flat command file', async () => {
    const f = join(dir, 'deploy.md');
    await writeFile(f, '---\nname: deploy\ndescription: deploy the app\n---\nDo the deploy.');
    const skills = await loadFlatSkills([f]);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: 'deploy', description: 'deploy the app', location: f });
  });

  it('falls back to the file basename when frontmatter has no name', async () => {
    const f = join(dir, 'rollback.md');
    await writeFile(f, 'Just a body, no frontmatter.');
    const skills = await loadFlatSkills([f]);
    expect(skills[0].name).toBe('rollback');
    expect(skills[0].location).toBe(f);
  });

  it('skips files that cannot be read without throwing', async () => {
    const skills = await loadFlatSkills([join(dir, 'missing.md')]);
    expect(skills).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Create `packages/agent/src/skills/flat.ts`:**

```ts
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import type { SkillDiscoveryResult } from './types.js';

/**
 * Loads flat single-file skills/commands (Claude Code `commands/*.md`) into
 * SkillDiscoveryResult objects. Name comes from frontmatter `name`, else the
 * file basename (without `.md`). Unreadable files are skipped (never throw).
 */
export async function loadFlatSkills(files: string[]): Promise<SkillDiscoveryResult[]> {
  const out: SkillDiscoveryResult[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(raw);
    const name = parsed?.frontmatter.name || basename(file).replace(/\.md$/, '');
    const description = parsed?.frontmatter.description ?? '';
    const content = parsed?.content ?? raw;
    out.push({ name, description, location: file, content, editable: false, source: 'agent' });
  }
  return out;
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Export** `loadFlatSkills` from `packages/agent/src/skills/index.ts` and re-export from `packages/agent/src/index.ts`.
- [ ] **Step 6: Wire into the backend.** In `packages/agent/src/backends/piagent.ts`, add a constructor param `extraSkillFiles: string[] = []` (store on `this`). In `listSkills()`, after `discoverSkills(...)`, append `await loadFlatSkills(this.extraSkillFiles)` (dedup-by-name handled downstream by the resource loader's merge, but de-dup here too: skip flat skills whose name already appears). Confirm `listSkillsAsPiSkills`/`setExtraSkills` carry them through unchanged.

```ts
// in listSkills():
const discovered = await discoverSkills({ managedSkillsDir: this.managedSkillsDir, paths: this.config.skills?.paths, includeBundled: this.config.skills?.includeBundled });
const flat = await loadFlatSkills(this.extraSkillFiles);
const seen = new Set(discovered.map((s) => s.name));
return [...discovered, ...flat.filter((s) => !seen.has(s.name))];
```

- [ ] **Step 7: Run agent tests under Node 22.23.0** (piagent imports pi): `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22.23.0; npx vitest run packages/agent/src/skills/flat.test.ts packages/agent/src/backends/piagent.contract.test.ts`. Expect PASS.
- [ ] **Step 8: Verify + commit.** `npm run build -w packages/agent && npm run typecheck`? (agent has no typecheck script; build's tsup dts covers it.) `npx biome check packages/agent/src/skills/flat.ts packages/agent/src/skills/flat.test.ts`.

```bash
git add packages/agent/src/skills/flat.ts packages/agent/src/skills/flat.test.ts \
  packages/agent/src/skills/index.ts packages/agent/src/index.ts packages/agent/src/backends/piagent.ts
git commit -m "feat(agent): load flat-file skills and accept extraSkillFiles in backend"
```

---

## Task 5 — Slash parser: Claude `/plugin:command` namespacing

**Files:**
- Modify: `packages/channels/src/commands.ts`
- Create/Modify: `packages/channels/src/commands.test.ts`

**Interfaces:**
- `parseSlashCommand` additionally recognizes `/<namespace>:<name> [input]` (Claude plugin command form) → `{ kind: 'skill', name: '<namespace>:<name>', input }`.

- [ ] **Step 1: Write failing test** `packages/channels/src/commands.test.ts` (create if it doesn't exist):

```ts
import { parseSlashCommand } from './commands.js';

describe('parseSlashCommand', () => {
  it('parses built-in /skills and /help', () => {
    expect(parseSlashCommand('/skills')).toEqual({ kind: 'skills' });
    expect(parseSlashCommand('/help')).toEqual({ kind: 'help' });
  });

  it('parses /skill:<name> [input]', () => {
    expect(parseSlashCommand('/skill:deploy now')).toEqual({ kind: 'skill', name: 'deploy', input: 'now' });
  });

  it('parses Claude-style /<plugin>:<command> [input]', () => {
    expect(parseSlashCommand('/myplugin:deploy staging')).toEqual({
      kind: 'skill',
      name: 'myplugin:deploy',
      input: 'staging',
    });
  });

  it('returns null for a plain message or unknown single-word slash', () => {
    expect(parseSlashCommand('hello')).toBeNull();
    expect(parseSlashCommand('/unknown')).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (the `/myplugin:deploy` case).

- [ ] **Step 3: Edit `parseSlashCommand`** in `packages/channels/src/commands.ts`. After the existing `/skill` match and before `return null`, add a namespaced-command match (a `/<seg>:<seg>` form where the first segment is not a reserved word):

```ts
  // Claude-style plugin command: /<plugin>:<command> [input]
  const ns = trimmed.match(/^\/([a-z0-9][a-z0-9-]*):(\S+)\s*([\s\S]*)$/i);
  if (ns) return { kind: 'skill', name: `${ns[1]}:${ns[2]}`, input: ns[3].trim() };

  return null;
```

(Place it AFTER the `/skill(?::|\s+)` match so `/skill:x` keeps its existing meaning; `/skill:x` matches the skill rule first.) Update `SLASH_HELP` to mention `/<plugin>:<command>`.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Verify + commit.** Build channels, biome.

```bash
git add packages/channels/src/commands.ts packages/channels/src/commands.test.ts
git commit -m "feat(channels): parse Claude /plugin:command slash form"
```

---

## Task 6 — Gateway wiring + full gate + docs

**Files:**
- Create: `apps/gateway/src/plugin-mcp.ts`
- Test: `apps/gateway/src/plugin-mcp.test.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/src/plugins-wiring.test.ts`
- Modify: `docs/configuration.mdx`

**Interfaces:**
- Produces: `registerPluginMcpServers(mcpManager, mcpConfigStore, mcpConfigs, logger): Promise<void>` — fail-isolated registration of translated plugin MCP servers (skip names that already exist; log + continue on error).

- [ ] **Step 1: Write failing test** `apps/gateway/src/plugin-mcp.test.ts` with fakes for `mcpManager`/`mcpConfigStore` (record added names; one throws to prove isolation):

```ts
import { registerPluginMcpServers } from './plugin-mcp.js';

function fakes() {
  const added: string[] = [];
  const stored: string[] = [];
  return {
    added,
    stored,
    mgr: { addServer: async (c: { name: string }) => { if (c.name === 'p-boom') throw new Error('boom'); added.push(c.name); } },
    store: { addConfig: async (c: { name: string }) => { stored.push(c.name); }, removeConfig: async () => {} },
    logger: { info() {}, warn() {} },
  };
}

describe('registerPluginMcpServers', () => {
  it('registers each config and persists it', async () => {
    const f = fakes();
    await registerPluginMcpServers(f.mgr as any, f.store as any, [
      { pluginName: 'p', config: { name: 'p-db', transport: { type: 'stdio', command: 'node' } } },
    ], f.logger as any);
    expect(f.added).toEqual(['p-db']);
    expect(f.stored).toEqual(['p-db']);
  });

  it('isolates a failing registration and continues', async () => {
    const f = fakes();
    await registerPluginMcpServers(f.mgr as any, f.store as any, [
      { pluginName: 'p', config: { name: 'p-boom', transport: { type: 'stdio', command: 'x' } } },
      { pluginName: 'p', config: { name: 'p-ok', transport: { type: 'stdio', command: 'y' } } },
    ], f.logger as any);
    expect(f.added).toEqual(['p-ok']);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Create `apps/gateway/src/plugin-mcp.ts`:**

```ts
import type { McpManager, McpServerConfig } from '@dash/mcp';

interface ConfigStore {
  addConfig(config: McpServerConfig): Promise<void>;
  removeConfig(name: string): Promise<void>;
}
interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * Registers translated plugin MCP servers with the running manager + config
 * store. Fail-isolated: a server that throws (bad spawn, dup name) is logged
 * and skipped — it never aborts the others or gateway startup. Servers whose
 * name already exists in the store are skipped (operator/other-plugin owns it).
 */
export async function registerPluginMcpServers(
  mcpManager: Pick<McpManager, 'addServer'>,
  store: ConfigStore,
  configs: Array<{ pluginName: string; config: McpServerConfig }>,
  logger: Logger,
): Promise<void> {
  for (const { pluginName, config } of configs) {
    try {
      await mcpManager.addServer(config);
      await store.addConfig(config);
      logger.info(`[plugins] registered MCP server '${config.name}' (plugin '${pluginName}')`);
    } catch (err) {
      logger.warn(`[plugins] MCP server '${config.name}' (plugin '${pluginName}') failed: ${(err as Error).message}`);
    }
  }
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Wire the gateway** (`apps/gateway/src/index.ts`). After the existing `loadPlugins` block:
  1. `await registerPluginMcpServers(mcpManager, mcpConfigStore, loadedPlugins.mcpConfigs, logger);`
  2. Prepend trusted plugin bin dirs to PATH: `if (loadedPlugins.binDirs.length) process.env.PATH = [...loadedPlugins.binDirs, process.env.PATH ?? ''].join(path.delimiter);` (import `delimiter` from `node:path`).
  3. Capture `const pluginCommandFiles = loadedPlugins.commandFiles;`.
  Then pass `extraSkillFiles: pluginCommandFiles` into the `PiAgentBackend` constructor (add the argument in the correct positional slot — it's a new trailing optional param after the projects tools; confirm the constructor order and append accordingly).

- [ ] **Step 6: Extend the wiring test** `apps/gateway/src/plugins-wiring.test.ts`: add a case that a plugin's `commands/foo.md` becomes discoverable as a skill named `foo` via `loadFlatSkills(loaded.commandFiles)`, and that an untrusted plugin contributes no `mcpConfigs`/`binDirs`. (Run under Node 22.23.0 — it imports `@dash/agent`.)

- [ ] **Step 7: Docs.** Extend the `## Plugins` section in `docs/configuration.mdx`: document that a `trusted: true` flag (alongside `enabled`) is required for `.mcp.json` servers and `bin/` executables (code execution), that `commands/*.md` become `/plugin:command` slash commands, and update the layout tree to show `.mcp.json`, `commands/`, and `bin/`. Keep the practical, copy-pasteable tone.

- [ ] **Step 8: Full gate under Node 22.23.0.** `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22.23.0; npm run lint && npm run build && npm test`. Expect all green. If a real failure (not the undici quirk) appears, STOP and report.

- [ ] **Step 9: Commit + push.**

```bash
git add apps/gateway/src/plugin-mcp.ts apps/gateway/src/plugin-mcp.test.ts \
  apps/gateway/src/index.ts apps/gateway/src/plugins-wiring.test.ts docs/configuration.mdx
git commit -m "feat(gateway): register trusted-plugin MCP + bin PATH, route plugin commands"
git push   # updates PR #47
```

---

## Self-review (run after writing the plan)

1. **Spec coverage:** commands ✓ (T2,T4,T5,T6), MCP ✓ (T1,T3,T6), bin ✓ (T2,T3,T6), trust gate enforced ✓ (T3). Deferred (correct): `${VAR}` expansion → Plan 3; hooks/subagents/providers → Plans 3–5.
2. **Placeholders:** none — every step has concrete code/commands.
3. **Type consistency:** `LoadedPlugins` new fields (`commandFiles`, `binDirs`, `mcpConfigs`) used identically in loader (T3) and gateway (T6); `translateMcpJson` output shape matches `registerPluginMcpServers` input; `extraSkillFiles` param threaded from gateway (T6) to backend (T4).
4. **Trust:** code-execution components (mcp, bin) require `trusted`; markdown (skills, commands) require only `enabled`; path-entries are not auto-trusted.
