# Dash Plugins — Foundation (Claude Code compat, Plan 1 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Dash discover unmodified Claude Code plugins on disk and route their `skills/` into every agent, behind an explicit enable gate.

**Architecture:** Two new packages — `@dash/plugin-sdk` (Claude Code manifest types, zero runtime) and `@dash/plugins` (host: manifest reader, config/trust store, fail-isolated loader). The gateway runs the loader after MCP setup and appends each loaded plugin's resolved skill directories to every agent's `config.skills.paths`, which `discoverSkills()` already scans. No `@dash/agent` change — skills ride the existing `DashAgentConfig.skills.paths` seam.

**Tech Stack:** Node.js 22+, ESM only, TypeScript strict / ES2024 / NodeNext. tsup single-entry build (`src/index.ts` → `dist/`). Vitest globals. Biome (2-space, single quotes, semicolons, 100-char). `@sinclair/typebox@^0.34.0` reserved for later plans (config validation) — not needed in Plan 1.

## Global Constraints

- **Runtime:** Node.js 22+, ESM only. Local imports use `.js` extensions.
- **TypeScript:** extends `tsconfig.base.json` (`target ES2024`, `module/moduleResolution NodeNext`, `strict`, `declaration`, `outDir dist`, `rootDir src`).
- **Build:** tsup block in `package.json` — `entry: ["src/index.ts"], format: ["esm"], dts: true, clean: true, sourcemap: true`.
- **Format:** Biome — 2-space indent, single quotes, semicolons always, 100-char width.
- **Tests:** Vitest globals (`describe`/`it`/`expect` ambient); test files `*.test.ts` beside source under `src/`; temp dirs via `mkdtemp`, cleaned in `afterEach`.
- **Manifest contract (Claude Code, verbatim):** plugin manifest is `.claude-plugin/plugin.json`; it is **optional** (name falls back to the directory basename); **only `name` is required** when present (kebab-case); **unrecognized top-level fields are ignored**; every component dir lives at the plugin root, never inside `.claude-plugin/`; component paths are **relative, starting with `./`**; the `skills` field **adds to** the default `skills/` scan (it does not replace it).
- **Versioning:** new packages start at the repo's current version `0.2.0` (match siblings).
- **Cross-plan contract:** the exported surface of `@dash/plugin-sdk` and `@dash/plugins` is consumed verbatim by Plans 2–5. Do not rename exported types/functions without updating this header.

---

## File structure

| File | Responsibility |
|------|----------------|
| `packages/plugin-sdk/package.json` | `@dash/plugin-sdk`, tsup build, `typecheck` script, no deps. |
| `packages/plugin-sdk/tsconfig.json` | Extends base; `types: ["node", "vitest/globals"]`. |
| `packages/plugin-sdk/src/index.ts` | Claude Code manifest types (`PluginManifest`, `PluginAuthor`) + `definePluginTypesVersion` no-op marker. |
| `packages/plugin-sdk/src/index.test.ts` | Type-surface baseline + runtime-export assertion. |
| `packages/plugins/package.json` | `@dash/plugins`; dep `@dash/plugin-sdk`. |
| `packages/plugins/tsconfig.json` | Extends base; `types: ["node", "vitest/globals"]`. |
| `packages/plugins/src/types.ts` | Host types: `PluginStatus`, `PluginFailure`, `PluginRecord`, `LoadedPlugins`, `PluginEntryConfig`. |
| `packages/plugins/src/index.ts` | Barrel — pinned `@dash/plugins` surface. |
| `packages/plugins/src/manifest.ts` | `MANIFEST_DIR`/`MANIFEST_FILENAME`, `readManifest`, `validateManifest`, `resolveSkillDirs`. |
| `packages/plugins/src/manifest.test.ts` | Manifest reading/validation/resolution tests. |
| `packages/plugins/src/config-store.ts` | `PluginConfigStore` at `<dataDir>/plugins/config.json` (atomic writes). |
| `packages/plugins/src/config-store.test.ts` | Config store load/persist/tolerance tests. |
| `packages/plugins/src/loader.ts` | `loadPlugins` — discovery, manifest, enable gate, skill-dir collection, fail isolation. |
| `packages/plugins/src/loader.test.ts` | Loader end-to-end over `mkdtemp` fixtures. |
| `packages/plugins/src/loader.dist.test.ts` | Imports BUILT `dist/index.js`, runs `loadPlugins`. |
| `apps/gateway/src/index.ts` | Modify: run loader after MCP, merge skill dirs into `config.skills.paths`. |
| `apps/gateway/src/plugins-wiring.test.ts` | End-to-end: fixture plugin → skills discoverable by an agent config. |
| Root `package.json` | `workspaces` + `build` + `lint` additions. |
| `vitest.config.ts` | `@dash/plugin-sdk` + `@dash/plugins` source aliases. |

## Scope / deliberate deferrals

This plan ships **on-disk skill plugins**. Deferred to later plans, each where it is first exercised (noted so the spec's goals are not silently dropped):

- **Commands** (`commands/*.md`) → Plan 2 (needs a flat-file→skill adapter; lands with MCP).
- **MCP, `bin/`** → Plan 2.
- **Hooks**, **path-var substitution** (`${CLAUDE_PLUGIN_ROOT}` etc.), **`userConfig`** → Plan 3 (load-bearing for hooks/MCP, not for markdown skills).
- **Subagents** → Plan 4. **Providers** → Plan 5.
- **Marketplace network fetch** (git/npm install) + **install-state file interop** (`installed_plugins.json`, `known_marketplaces.json`, `blocklist.json`) → a dedicated increment; Plan 1 discovers plugins already present under `<dataDir>/plugins/` (the `--plugin-dir` equivalent).
- **Trust gate for code execution** — `PluginEntryConfig` carries `trusted` now, but Plan 1 only loads markdown skills (no code execution), so it gates on `enabled` alone; `trusted` is enforced from Plan 2 on.

---

## Task 1 — Scaffold `@dash/plugin-sdk` (manifest types)

**Files:**
- Create: `packages/plugin-sdk/package.json`
- Create: `packages/plugin-sdk/tsconfig.json`
- Create: `packages/plugin-sdk/src/index.ts`
- Test: `packages/plugin-sdk/src/index.test.ts`
- Modify: `package.json` (root — workspaces, build, lint)
- Modify: `vitest.config.ts` (alias)

**Interfaces:**
- Produces: `PluginManifest`, `PluginAuthor` (types); `PLUGIN_TYPES_VERSION` (runtime const).

- [ ] **Step 1: Write the failing test** `packages/plugin-sdk/src/index.test.ts`

```ts
import type { PluginAuthor, PluginManifest } from './index.js';
import * as sdk from './index.js';

// Type-surface baseline: these names are a cross-plan contract (Plans 2–5
// import them verbatim). vitest erases types — the tuple is checked by
// `tsc --noEmit` via `npm run typecheck`.
export type TypeSurfaceBaseline = [PluginManifest, PluginAuthor];

describe('@dash/plugin-sdk surface', () => {
  it('exports exactly the expected runtime names', () => {
    expect(Object.keys(sdk).sort()).toEqual(['PLUGIN_TYPES_VERSION']);
  });

  it('PluginManifest requires only name', () => {
    const m: PluginManifest = { name: 'demo' };
    expect(m.name).toBe('demo');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/plugin-sdk/src/index.test.ts`
Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 3: Create `packages/plugin-sdk/package.json`**

```json
{
  "name": "@dash/plugin-sdk",
  "version": "0.2.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit"
  },
  "tsup": {
    "entry": ["src/index.ts"],
    "format": ["esm"],
    "dts": true,
    "clean": true,
    "sourcemap": true
  }
}
```

- [ ] **Step 4: Create `packages/plugin-sdk/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Create `packages/plugin-sdk/src/index.ts`**

```ts
/**
 * @dash/plugin-sdk — author/host-shared types for Claude Code-compatible
 * Dash plugins. Types-heavy, near-zero runtime. No dependency on any other
 * @dash package. Grows per plan (hook payloads in Plan 3, ProviderCatalog in
 * Plan 5); Plan 1 defines only the manifest.
 *
 * The manifest is Claude Code's `.claude-plugin/plugin.json`. It is OPTIONAL
 * (name falls back to the plugin directory basename); when present, only
 * `name` is required, and unrecognized top-level fields are IGNORED so one
 * manifest can double as a Claude/Codex/Cursor manifest.
 */

export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

export interface PluginManifest {
  /** kebab-case; namespaces the plugin's components. Required when a manifest exists. */
  name: string;
  /** Human-readable name for pickers; falls back to `name`. */
  displayName?: string;
  /** Semver. If omitted, the host falls back to a git SHA / 'unknown'. */
  version?: string;
  description?: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  /**
   * Extra skill directories (each containing `<name>/SKILL.md`). Relative,
   * starting with './'. ADDS to the default `skills/` scan (never replaces it).
   */
  skills?: string[];
  /**
   * Command directories/files (`*.md`). Relative, starting with './'.
   * REPLACES the default `commands/` scan. Parsed in Plan 2.
   */
  commands?: string[];
}

/** Marker so the host can assert it links a compatible SDK build. */
export const PLUGIN_TYPES_VERSION = 1 as const;
```

- [ ] **Step 6: Modify root `package.json`**

Add `"packages/plugin-sdk"` to `workspaces` immediately after `"packages/models"`. Add `-w packages/plugin-sdk` to the `build` script immediately after `-w packages/models`. Change `lint` to append the typecheck:

```json
"lint": "biome check . && npm run typecheck --workspace=apps/mission-control && npm run typecheck --workspace=packages/plugin-sdk"
```

- [ ] **Step 7: Modify `vitest.config.ts`**

Add to `resolve.alias` (alongside `@dash/projects`):

```ts
      '@dash/plugin-sdk': resolve(__dirname, 'packages/plugin-sdk/src/index.ts'),
```

- [ ] **Step 8: Install + verify**

Run: `npm install`
Run: `npx vitest run packages/plugin-sdk/src/index.test.ts`
Expected: PASS.
Run: `npm run build -w packages/plugin-sdk && npm run typecheck --workspace=packages/plugin-sdk`
Expected: emits `dist/index.js` + `dist/index.d.ts`; typecheck passes.
Run: `npx biome check packages/plugin-sdk vitest.config.ts package.json`
Expected: clean (fix if flagged).

- [ ] **Step 9: Commit**

```bash
git add packages/plugin-sdk/package.json packages/plugin-sdk/tsconfig.json \
  packages/plugin-sdk/src/index.ts packages/plugin-sdk/src/index.test.ts \
  package.json package-lock.json vitest.config.ts
git commit -m "feat(plugin-sdk): scaffold @dash/plugin-sdk with Claude Code manifest types"
```

---

## Task 2 — Scaffold `@dash/plugins` (host types + barrel)

**Files:**
- Create: `packages/plugins/package.json`
- Create: `packages/plugins/tsconfig.json`
- Create: `packages/plugins/src/types.ts`
- Create: `packages/plugins/src/index.ts`
- Test: `packages/plugins/src/types.test.ts`
- Modify: `package.json` (root — workspaces, build, lint)
- Modify: `vitest.config.ts` (alias)

**Interfaces:**
- Consumes: `@dash/plugin-sdk` (`PluginManifest`).
- Produces: `PluginStatus`, `PluginFailurePhase`, `PluginFailure`, `PluginRecord`, `LoadedPlugins`, `PluginEntryConfig`.

- [ ] **Step 1: Write the failing test** `packages/plugins/src/types.test.ts`

```ts
import type {
  LoadedPlugins,
  PluginEntryConfig,
  PluginFailure,
  PluginRecord,
  PluginStatus,
} from './index.js';

// Cross-plan type-surface baseline (checked by tsc --noEmit via typecheck).
export type TypeSurfaceBaseline = [
  PluginStatus,
  PluginFailure,
  PluginRecord,
  LoadedPlugins,
  PluginEntryConfig,
];

describe('@dash/plugins host types', () => {
  it('PluginRecord composes status + skillDirs', () => {
    const r: PluginRecord = {
      name: 'demo',
      status: 'loaded',
      dir: '/x',
      skillDirs: ['/x/skills'],
      activated: ['skills'],
      noop: [],
    };
    expect(r.activated).toEqual(['skills']);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/plugins/src/types.test.ts`
Expected: FAIL — module not resolvable.

- [ ] **Step 3: Create `packages/plugins/package.json`**

```json
{
  "name": "@dash/plugins",
  "version": "0.2.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dash/plugin-sdk": "*"
  },
  "tsup": {
    "entry": ["src/index.ts"],
    "format": ["esm"],
    "dts": true,
    "clean": true,
    "sourcemap": true
  }
}
```

- [ ] **Step 4: Create `packages/plugins/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Create `packages/plugins/src/types.ts`**

```ts
export type PluginStatus = 'loaded' | 'disabled' | 'error';

export type PluginFailurePhase = 'discovery' | 'manifest' | 'route';

export interface PluginFailure {
  phase: PluginFailurePhase;
  error: string;
  /** ISO timestamp. */
  failedAt: string;
}

/**
 * Per-plugin config + trust entry, persisted at <dataDir>/plugins/config.json.
 * `enabled` gates visibility; `trusted` additionally gates code-execution
 * components (hooks/MCP/providers/bin) introduced in Plan 2+. `path` points a
 * named entry at a local/linked dev plugin dir (auto-enabled — explicit intent).
 */
export interface PluginEntryConfig {
  enabled: boolean;
  trusted?: boolean;
  config?: Record<string, unknown>;
  path?: string;
}

export interface PluginRecord {
  name: string;
  version?: string;
  description?: string;
  status: PluginStatus;
  /** Absolute plugin root directory. */
  dir: string;
  /** Resolved skill directories this plugin contributes (each scanned for <name>/SKILL.md). */
  skillDirs: string[];
  /** Component kinds activated this plan, e.g. ['skills']. */
  activated: string[];
  /** Component kinds present on disk but not activated yet (deferred plans). */
  noop: string[];
  failure?: PluginFailure;
}

export interface LoadedPlugins {
  records: PluginRecord[];
  /** Flattened skill dirs across all loaded plugins (for config.skills.paths). */
  skillDirs: string[];
}
```

- [ ] **Step 6: Create `packages/plugins/src/index.ts`** (barrel — grows in later tasks)

```ts
export type {
  LoadedPlugins,
  PluginEntryConfig,
  PluginFailure,
  PluginFailurePhase,
  PluginRecord,
  PluginStatus,
} from './types.js';
```

- [ ] **Step 7: Modify root `package.json`**

Add `"packages/plugins"` to `workspaces` immediately after `"packages/plugin-sdk"`. Add `-w packages/plugins` to `build` immediately after `-w packages/plugin-sdk`. Append to `lint`: `&& npm run typecheck --workspace=packages/plugins`.

- [ ] **Step 8: Modify `vitest.config.ts`**

Add to `resolve.alias`:

```ts
      '@dash/plugins': resolve(__dirname, 'packages/plugins/src/index.ts'),
```

- [ ] **Step 9: Install + verify**

Run: `npm install`
Run: `npx vitest run packages/plugins/src/types.test.ts` → PASS.
Run: `npm run build -w packages/plugin-sdk -w packages/plugins && npm run typecheck --workspace=packages/plugins` → passes (typecheck resolves `@dash/plugin-sdk` through its built `dist/index.d.ts`; build plugin-sdk first).
Run: `npx biome check packages/plugins package.json` → clean.

- [ ] **Step 10: Commit**

```bash
git add packages/plugins/package.json packages/plugins/tsconfig.json \
  packages/plugins/src/types.ts packages/plugins/src/index.ts \
  packages/plugins/src/types.test.ts package.json package-lock.json vitest.config.ts
git commit -m "feat(plugins): scaffold @dash/plugins host types and barrel"
```

---

## Task 3 — Manifest reader (`.claude-plugin/plugin.json`)

**Files:**
- Create: `packages/plugins/src/manifest.ts`
- Test: `packages/plugins/src/manifest.test.ts`
- Modify: `packages/plugins/src/index.ts` (export)

**Interfaces:**
- Consumes: `PluginManifest` from `@dash/plugin-sdk`.
- Produces: `MANIFEST_DIR`, `MANIFEST_FILENAME`, `readManifest(dir): Promise<PluginManifest>`, `validateManifest(raw, dir): PluginManifest`, `resolveSkillDirs(dir, manifest): string[]`.

- [ ] **Step 1: Write the failing test** `packages/plugins/src/manifest.test.ts`

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANIFEST_DIR,
  MANIFEST_FILENAME,
  readManifest,
  resolveSkillDirs,
  validateManifest,
} from './manifest.js';

describe('validateManifest', () => {
  it('accepts a minimal manifest (name only) and ignores unknown fields', () => {
    const m = validateManifest({ name: 'my-plugin', futureField: 1 }, '/x/my-plugin');
    expect(m.name).toBe('my-plugin');
    expect((m as Record<string, unknown>).futureField).toBeUndefined();
  });

  it('falls back to the directory basename when name is absent', () => {
    const m = validateManifest({ description: 'x' }, '/x/dir-name');
    expect(m.name).toBe('dir-name');
  });

  it('rejects a non-kebab-case name', () => {
    expect(() => validateManifest({ name: 'MyPlugin' }, '/x/p')).toThrow(/kebab-case/);
  });

  it('rejects non-object input', () => {
    expect(() => validateManifest([], '/x/p')).toThrow(/object/);
  });

  it('normalizes string skills to an array', () => {
    const m = validateManifest({ name: 'p', skills: './extra-skills' }, '/x/p');
    expect(m.skills).toEqual(['./extra-skills']);
  });
});

describe('readManifest', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-plugin-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads and validates .claude-plugin/plugin.json', async () => {
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(
      join(dir, MANIFEST_DIR, MANIFEST_FILENAME),
      JSON.stringify({ name: 'disco', version: '1.2.0' }),
    );
    const m = await readManifest(dir);
    expect(m.name).toBe('disco');
    expect(m.version).toBe('1.2.0');
  });

  it('derives a manifest from the dir name when the file is absent (optional manifest)', async () => {
    const sub = join(dir, 'auto-named');
    await mkdir(sub, { recursive: true });
    const m = await readManifest(sub);
    expect(m.name).toBe('auto-named');
  });

  it('throws on invalid JSON', async () => {
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(join(dir, MANIFEST_DIR, MANIFEST_FILENAME), '{ not json');
    await expect(readManifest(dir)).rejects.toThrow(/invalid JSON/);
  });
});

describe('resolveSkillDirs', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-skills-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('includes the default skills/ dir when present and adds manifest paths', async () => {
    await mkdir(join(dir, 'skills'), { recursive: true });
    await mkdir(join(dir, 'extra'), { recursive: true });
    const dirs = resolveSkillDirs(dir, { name: 'p', skills: ['./extra'] });
    expect(dirs).toEqual([join(dir, 'skills'), join(dir, 'extra')]);
  });

  it('returns empty when no skills dir exists', () => {
    const dirs = resolveSkillDirs(dir, { name: 'p' });
    expect(dirs).toEqual([]);
  });

  it('ignores non-relative or missing manifest skill paths', async () => {
    await mkdir(join(dir, 'skills'), { recursive: true });
    const dirs = resolveSkillDirs(dir, { name: 'p', skills: ['/abs/path', './missing'] });
    expect(dirs).toEqual([join(dir, 'skills')]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/plugins/src/manifest.test.ts`
Expected: FAIL — `./manifest.js` not found.

- [ ] **Step 3: Create `packages/plugins/src/manifest.ts`**

```ts
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { PluginManifest } from '@dash/plugin-sdk';

/** Claude Code: the manifest lives at `<pluginRoot>/.claude-plugin/plugin.json`. */
export const MANIFEST_DIR = '.claude-plugin';
export const MANIFEST_FILENAME = 'plugin.json';

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function normalizePaths(v: unknown): string[] | undefined {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return undefined;
}

/**
 * Validates a parsed manifest object against Claude Code semantics: only
 * `name` is meaningful-required (absent → directory basename), it must be
 * kebab-case, and unrecognized top-level fields are dropped (ignored).
 */
export function validateManifest(raw: unknown, dir: string): PluginManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('plugin.json must be a JSON object');
  }
  const m = raw as Record<string, unknown>;
  const name = typeof m.name === 'string' && m.name.length > 0 ? m.name : basename(dir);
  if (!KEBAB_CASE.test(name)) {
    throw new Error(`plugin 'name' must be kebab-case, got '${name}'`);
  }
  return {
    name,
    displayName: typeof m.displayName === 'string' ? m.displayName : undefined,
    version: typeof m.version === 'string' ? m.version : undefined,
    description: typeof m.description === 'string' ? m.description : undefined,
    skills: normalizePaths(m.skills),
    commands: normalizePaths(m.commands),
  };
}

/**
 * Reads `<dir>/.claude-plugin/plugin.json`. The manifest is OPTIONAL: when
 * absent, the plugin is named after its directory (which must be kebab-case).
 */
export async function readManifest(dir: string): Promise<PluginManifest> {
  const path = join(dir, MANIFEST_DIR, MANIFEST_FILENAME);
  if (!existsSync(path)) {
    const name = basename(dir);
    if (!KEBAB_CASE.test(name)) {
      throw new Error(
        `plugin at ${dir} has no ${MANIFEST_DIR}/${MANIFEST_FILENAME} and dir name '${name}' is not kebab-case`,
      );
    }
    return { name };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${(err as Error).message}`);
  }
  return validateManifest(raw, dir);
}

/**
 * Resolves the skill directories a plugin contributes: the default `skills/`
 * dir (when present) PLUS any `skills` manifest entries (relative, './'-prefixed,
 * existing). Claude Code semantics: `skills` ADDS to the default, never replaces.
 */
export function resolveSkillDirs(dir: string, manifest: PluginManifest): string[] {
  const dirs: string[] = [];
  const def = join(dir, 'skills');
  if (existsSync(def)) dirs.push(def);
  for (const p of manifest.skills ?? []) {
    if (!p.startsWith('./')) continue;
    const abs = resolve(dir, p);
    if (existsSync(abs)) dirs.push(abs);
  }
  return dirs;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run packages/plugins/src/manifest.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Export from the barrel** — append to `packages/plugins/src/index.ts`:

```ts
export {
  MANIFEST_DIR,
  MANIFEST_FILENAME,
  readManifest,
  resolveSkillDirs,
  validateManifest,
} from './manifest.js';
```

- [ ] **Step 6: Verify + commit**

Run: `npm run build -w packages/plugins && npm run typecheck --workspace=packages/plugins` → passes.
Run: `npx biome check packages/plugins` → clean.

```bash
git add packages/plugins/src/manifest.ts packages/plugins/src/manifest.test.ts \
  packages/plugins/src/index.ts
git commit -m "feat(plugins): Claude Code manifest reader + skill-dir resolution"
```

---

## Task 4 — `PluginConfigStore` (enable/trust state)

**Files:**
- Create: `packages/plugins/src/config-store.ts`
- Test: `packages/plugins/src/config-store.test.ts`
- Modify: `packages/plugins/src/index.ts` (export)

**Interfaces:**
- Consumes: `PluginEntryConfig` from `./types.js`.
- Produces: `PluginConfigStore` with `load(): Promise<Record<string, PluginEntryConfig>>`, `setEnabled(name, enabled)`, `setTrusted(name, trusted)`.

- [ ] **Step 1: Write the failing test** `packages/plugins/src/config-store.test.ts`

```ts
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginConfigStore } from './config-store.js';

describe('PluginConfigStore', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'plugin-cfg-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns {} when the file is missing', async () => {
    const store = new PluginConfigStore(dataDir);
    expect(await store.load()).toEqual({});
  });

  it('returns {} when the file is corrupt', async () => {
    await mkdir(join(dataDir, 'plugins'), { recursive: true });
    await writeFile(join(dataDir, 'plugins', 'config.json'), '{ broken');
    const store = new PluginConfigStore(dataDir);
    expect(await store.load()).toEqual({});
  });

  it('parses entries with enabled/trusted/path', async () => {
    await mkdir(join(dataDir, 'plugins'), { recursive: true });
    await writeFile(
      join(dataDir, 'plugins', 'config.json'),
      JSON.stringify({ disco: { enabled: true, trusted: true, path: './dev/disco' } }),
    );
    const store = new PluginConfigStore(dataDir);
    expect(await store.load()).toEqual({
      disco: { enabled: true, trusted: true, config: undefined, path: './dev/disco' },
    });
  });

  it('persists enable/trust atomically and round-trips', async () => {
    const store = new PluginConfigStore(dataDir);
    await store.setEnabled('disco', true);
    await store.setTrusted('disco', true);
    const onDisk = JSON.parse(await readFile(join(dataDir, 'plugins', 'config.json'), 'utf8'));
    expect(onDisk.disco.enabled).toBe(true);
    expect(onDisk.disco.trusted).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/plugins/src/config-store.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `packages/plugins/src/config-store.ts`** (adapts the atomic-write pattern from `apps/gateway/src/agent-registry.ts`)

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PluginEntryConfig } from './types.js';

/**
 * Persistence for the plugins enable/trust block at
 * <dataDir>/plugins/config.json. load() tolerates a missing or corrupt file
 * (returns {}); writes are atomic (temp + rename).
 */
export class PluginConfigStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'plugins', 'config.json');
  }

  async load(): Promise<Record<string, PluginEntryConfig>> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch {
      return {};
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const entries: Record<string, PluginEntryConfig> = {};
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const v = value as Record<string, unknown>;
      entries[name] = {
        enabled: v.enabled === true,
        trusted: v.trusted === true ? true : undefined,
        config:
          typeof v.config === 'object' && v.config !== null && !Array.isArray(v.config)
            ? (v.config as Record<string, unknown>)
            : undefined,
        path: typeof v.path === 'string' ? v.path : undefined,
      };
    }
    return entries;
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const entries = await this.load();
    entries[name] = { ...(entries[name] ?? { enabled: false }), enabled };
    await this.save(entries);
  }

  async setTrusted(name: string, trusted: boolean): Promise<void> {
    const entries = await this.load();
    entries[name] = { ...(entries[name] ?? { enabled: false }), trusted };
    await this.save(entries);
  }

  private async save(entries: Record<string, PluginEntryConfig>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(entries, null, 2));
    await rename(tmpPath, this.filePath);
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run packages/plugins/src/config-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Export from the barrel** — append to `packages/plugins/src/index.ts`:

```ts
export { PluginConfigStore } from './config-store.js';
```

- [ ] **Step 6: Verify + commit**

Run: `npm run build -w packages/plugins && npm run typecheck --workspace=packages/plugins` → passes.
Run: `npx biome check packages/plugins` → clean.

```bash
git add packages/plugins/src/config-store.ts packages/plugins/src/config-store.test.ts \
  packages/plugins/src/index.ts
git commit -m "feat(plugins): PluginConfigStore for enable/trust state"
```

---

## Task 5 — Loader (`loadPlugins`)

**Files:**
- Create: `packages/plugins/src/loader.ts`
- Test: `packages/plugins/src/loader.test.ts`
- Modify: `packages/plugins/src/index.ts` (export)

**Interfaces:**
- Consumes: `readManifest`/`resolveSkillDirs` (Task 3), `PluginEntryConfig`/`PluginRecord`/`LoadedPlugins` (Tasks 2).
- Produces: `LoadPluginsOptions`, `loadPlugins(opts): Promise<LoadedPlugins>`.

Behavior pinned: (1) discovery = explicit `path:` config entries first, then subdirectories of `pluginsDir`; (2) a `path:` entry is auto-enabled (explicit intent), a directory-discovered plugin requires `enabled: true`; (3) one plugin throwing is recorded as an `error` record and never aborts the others ("gateway always starts"); (4) `skillDirs` is the flattened union from `loaded` records, in discovery order.

- [ ] **Step 1: Write the failing test** `packages/plugins/src/loader.test.ts`

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST_DIR, MANIFEST_FILENAME } from './manifest.js';
import { loadPlugins } from './loader.js';

async function writePlugin(
  root: string,
  name: string,
  opts: { skill?: string; manifest?: Record<string, unknown> | false } = {},
): Promise<string> {
  const dir = join(root, name);
  if (opts.manifest !== false) {
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(
      join(dir, MANIFEST_DIR, MANIFEST_FILENAME),
      JSON.stringify(opts.manifest ?? { name }),
    );
  } else {
    await mkdir(dir, { recursive: true });
  }
  if (opts.skill) {
    await mkdir(join(dir, 'skills', opts.skill), { recursive: true });
    await writeFile(
      join(dir, 'skills', opts.skill, 'SKILL.md'),
      `---\nname: ${opts.skill}\ndescription: test skill\n---\nbody`,
    );
  }
  return dir;
}

describe('loadPlugins', () => {
  let dataDir: string;
  let pluginsDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'loader-'));
    pluginsDir = join(dataDir, 'plugins');
    await mkdir(pluginsDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('loads an enabled plugin and collects its skill dir', async () => {
    const dir = await writePlugin(pluginsDir, 'disco', { skill: 'greet' });
    const loaded = await loadPlugins({
      pluginsDir,
      entries: { disco: { enabled: true } },
    });
    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0]).toMatchObject({ name: 'disco', status: 'loaded', activated: ['skills'] });
    expect(loaded.skillDirs).toEqual([join(dir, 'skills')]);
  });

  it('marks a discovered-but-not-enabled plugin disabled (inert)', async () => {
    await writePlugin(pluginsDir, 'disco', { skill: 'greet' });
    const loaded = await loadPlugins({ pluginsDir, entries: {} });
    expect(loaded.records[0]).toMatchObject({ name: 'disco', status: 'disabled' });
    expect(loaded.skillDirs).toEqual([]);
  });

  it('auto-enables a path: entry (explicit dev intent)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devplug-'));
    const dir = await writePlugin(root, 'devkit', { skill: 'x' });
    const loaded = await loadPlugins({
      pluginsDir,
      entries: { devkit: { enabled: false, path: dir } },
    });
    expect(loaded.records[0]).toMatchObject({ name: 'devkit', status: 'loaded' });
    expect(loaded.skillDirs).toEqual([join(dir, 'skills')]);
    await rm(root, { recursive: true, force: true });
  });

  it('isolates a failing plugin and still loads the good one', async () => {
    await writePlugin(pluginsDir, 'good', { skill: 'g' });
    // bad: invalid JSON manifest
    const badDir = join(pluginsDir, 'bad');
    await mkdir(join(badDir, MANIFEST_DIR), { recursive: true });
    await writeFile(join(badDir, MANIFEST_DIR, MANIFEST_FILENAME), '{ broken');
    const loaded = await loadPlugins({
      pluginsDir,
      entries: { good: { enabled: true }, bad: { enabled: true } },
    });
    const byName = Object.fromEntries(loaded.records.map((r) => [r.name, r]));
    expect(byName.good.status).toBe('loaded');
    expect(byName.bad.status).toBe('error');
    expect(byName.bad.failure?.phase).toBe('manifest');
  });

  it('returns [] records when pluginsDir does not exist and no path entries', async () => {
    const loaded = await loadPlugins({ pluginsDir: join(dataDir, 'nope'), entries: {} });
    expect(loaded.records).toEqual([]);
    expect(loaded.skillDirs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/plugins/src/loader.test.ts`
Expected: FAIL — `./loader.js` missing.

- [ ] **Step 3: Create `packages/plugins/src/loader.ts`**

```ts
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readManifest, resolveSkillDirs } from './manifest.js';
import type { LoadedPlugins, PluginEntryConfig, PluginRecord } from './types.js';

export interface LoadPluginsOptions {
  /** Directory holding installed plugins (one subdir per plugin), e.g. <dataDir>/plugins. */
  pluginsDir: string;
  /** Enable/trust + path entries from PluginConfigStore. */
  entries: Record<string, PluginEntryConfig>;
  logger?: { info(msg: string): void; warn(msg: string): void };
}

/**
 * Discovers Claude Code plugins and routes their skills. Discovery order:
 * explicit `path:` entries first (auto-enabled — explicit intent), then
 * subdirectories of `pluginsDir` (which require `enabled: true`). Each plugin
 * is loaded in isolation: a throw becomes an `error` PluginRecord and never
 * aborts the others, so the host always starts.
 */
export async function loadPlugins(opts: LoadPluginsOptions): Promise<LoadedPlugins> {
  const targets = new Map<string, { dir: string; entry: PluginEntryConfig; fromPath: boolean }>();

  // 1. Explicit path entries (highest precedence, auto-enabled).
  for (const [name, entry] of Object.entries(opts.entries)) {
    if (entry.path) {
      targets.set(name, { dir: resolve(entry.path), entry, fromPath: true });
    }
  }

  // 2. Installed plugins under pluginsDir.
  if (existsSync(opts.pluginsDir)) {
    for (const d of readdirSync(opts.pluginsDir, { withFileTypes: true })) {
      if (!d.isDirectory() || targets.has(d.name)) continue;
      targets.set(d.name, {
        dir: join(opts.pluginsDir, d.name),
        entry: opts.entries[d.name] ?? { enabled: false },
        fromPath: false,
      });
    }
  }

  const records: PluginRecord[] = [];
  const skillDirs: string[] = [];

  for (const [discoveredName, { dir, entry, fromPath }] of targets) {
    try {
      const manifest = await readManifest(dir);
      const enabled = fromPath || entry.enabled;
      if (!enabled) {
        records.push({
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          status: 'disabled',
          dir,
          skillDirs: [],
          activated: [],
          noop: ['skills'],
        });
        continue;
      }
      const sDirs = resolveSkillDirs(dir, manifest);
      skillDirs.push(...sDirs);
      const activated = sDirs.length > 0 ? ['skills'] : [];
      records.push({
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        status: 'loaded',
        dir,
        skillDirs: sDirs,
        activated,
        noop: sDirs.length > 0 ? [] : ['skills'],
      });
      opts.logger?.info(`[plugins] loaded '${manifest.name}' (${activated.join(', ') || 'no components'})`);
    } catch (err) {
      const message = (err as Error).message;
      opts.logger?.warn(`[plugins] failed to load '${discoveredName}': ${message}`);
      records.push({
        name: discoveredName,
        status: 'error',
        dir,
        skillDirs: [],
        activated: [],
        noop: [],
        failure: { phase: 'manifest', error: message, failedAt: new Date().toISOString() },
      });
    }
  }

  return { records, skillDirs };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run packages/plugins/src/loader.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Export from the barrel** — append to `packages/plugins/src/index.ts`:

```ts
export { loadPlugins } from './loader.js';
export type { LoadPluginsOptions } from './loader.js';
```

- [ ] **Step 6: Verify + commit**

Run: `npm run build -w packages/plugins && npm run typecheck --workspace=packages/plugins` → passes.
Run: `npx biome check packages/plugins` → clean.

```bash
git add packages/plugins/src/loader.ts packages/plugins/src/loader.test.ts \
  packages/plugins/src/index.ts
git commit -m "feat(plugins): fail-isolated loader that routes plugin skills"
```

---

## Task 6 — dist-import smoke test

**Files:**
- Test: `packages/plugins/src/loader.dist.test.ts`

**Why:** ESM `.js`-extension import + tsup `dts`/`exports` can pass in source but break from `dist/`. Exercising the BUILT entry catches packaging regressions (the projects migration-runner lesson).

**Interfaces:**
- Consumes: the built `@dash/plugins` `dist/index.js`.

- [ ] **Step 1: Write the test** `packages/plugins/src/loader.dist.test.ts`

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Import the BUILT entry, not source — proves dist packaging works.
import { loadPlugins, MANIFEST_DIR, MANIFEST_FILENAME } from '../dist/index.js';

describe('@dash/plugins dist entry', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'loader-dist-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('loadPlugins works from the built bundle', async () => {
    const pluginsDir = join(dataDir, 'plugins');
    const dir = join(pluginsDir, 'disco');
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(join(dir, MANIFEST_DIR, MANIFEST_FILENAME), JSON.stringify({ name: 'disco' }));
    await mkdir(join(dir, 'skills', 'greet'), { recursive: true });
    await writeFile(join(dir, 'skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: x\n---\nb');

    const loaded = await loadPlugins({ pluginsDir, entries: { disco: { enabled: true } } });
    expect(loaded.records[0].status).toBe('loaded');
    expect(loaded.skillDirs).toEqual([join(dir, 'skills')]);
  });
});
```

- [ ] **Step 2: Build then run**

Run: `npm run build -w packages/plugin-sdk -w packages/plugins`
Run: `npx vitest run packages/plugins/src/loader.dist.test.ts`
Expected: PASS. (If it fails to resolve `../dist/index.js`, the build step was skipped — build first.)

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/src/loader.dist.test.ts
git commit -m "test(plugins): dist-import smoke test for loadPlugins"
```

---

## Task 7 — Gateway wiring (skills reach agents)

**Files:**
- Modify: `apps/gateway/src/index.ts` (run loader after MCP; merge skill dirs into agent config)
- Modify: `apps/gateway/package.json` (add `@dash/plugins` dependency)
- Test: `apps/gateway/src/plugins-wiring.test.ts`

**Interfaces:**
- Consumes: `loadPlugins`, `PluginConfigStore` from `@dash/plugins`; `discoverSkills` from `@dash/agent` (test only).
- Produces: plugin skill dirs merged into every agent's effective `config.skills.paths`.

Integration point (verbatim anchors): after `mcpManager.start()` (currently `apps/gateway/src/index.ts:95-98`) and before `createAgentChatCoordinator` (currently `:127`). The merge happens inside `createBackend`, where `skills: agentConfig.skills` is passed to `new PiAgentBackend(...)` (currently `:193`).

- [ ] **Step 1: Write the failing test** `apps/gateway/src/plugins-wiring.test.ts`

This tests the wiring contract in isolation — that the loader's `skillDirs` make a plugin skill discoverable through the same `discoverSkills` path the backend uses — without booting the whole gateway.

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills } from '@dash/agent';
import { loadPlugins, MANIFEST_DIR, MANIFEST_FILENAME } from '@dash/plugins';

describe('gateway plugin → skill wiring', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'gw-plugins-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('a loaded plugin skill is discoverable via config.skills.paths', async () => {
    const pluginsDir = join(dataDir, 'plugins');
    const dir = join(pluginsDir, 'disco');
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(join(dir, MANIFEST_DIR, MANIFEST_FILENAME), JSON.stringify({ name: 'disco' }));
    await mkdir(join(dir, 'skills', 'greeter'), { recursive: true });
    await writeFile(
      join(dir, 'skills', 'greeter', 'SKILL.md'),
      '---\nname: greeter\ndescription: greets people\n---\nSay hi.',
    );

    const loaded = await loadPlugins({ pluginsDir, entries: { disco: { enabled: true } } });

    // Mirror the gateway merge: plugin skill dirs appended to agent skills.paths.
    const skills = await discoverSkills({ paths: loaded.skillDirs, includeBundled: false });
    expect(skills.map((s) => s.name)).toContain('greeter');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run apps/gateway/src/plugins-wiring.test.ts`
Expected: FAIL — `@dash/plugins` not a dependency of `apps/gateway` yet (or alias resolves but dep missing). Add the dependency in Step 3.

- [ ] **Step 3: Add the dependency** to `apps/gateway/package.json` `dependencies`:

```json
    "@dash/plugins": "*",
```

Run: `npm install`
Run: `npx vitest run apps/gateway/src/plugins-wiring.test.ts`
Expected: PASS (the wiring contract holds; now wire it into the real bootstrap).

- [ ] **Step 4: Add the loader to the bootstrap.** In `apps/gateway/src/index.ts`, add the import near the other `@dash/*` imports:

```ts
import { loadPlugins, PluginConfigStore } from '@dash/plugins';
```

Then, immediately after the MCP block (after the `if (mcpConfigs.length > 0) { ... await mcpManager.start(); }` lines, currently ~`:98`), insert:

```ts
  // Plugin host — discover Claude Code plugins under <dataDir>/plugins and
  // route their skills. Skills are markdown (no code execution), so they load
  // for any `enabled` plugin; `trusted` gates code-execution components in
  // later increments. The loader never throws — a bad plugin is recorded and
  // skipped so the gateway always starts.
  const pluginConfigStore = new PluginConfigStore(dataDir);
  const pluginEntries = await pluginConfigStore.load();
  const loadedPlugins = await loadPlugins({
    pluginsDir: resolve(dataDir, 'plugins'),
    entries: pluginEntries,
    logger,
  });
  const pluginSkillDirs = loadedPlugins.skillDirs;
  for (const r of loadedPlugins.records) {
    if (r.status === 'error') {
      console.warn(`[plugins] '${r.name}' failed: ${r.failure?.error}`);
    }
  }
```

- [ ] **Step 5: Merge plugin skill dirs into every agent.** In the `createBackend` callback (currently `apps/gateway/src/index.ts:131`), change the `skills` field passed to `PiAgentBackend` (currently `:193` `skills: agentConfig.skills,`) to merge the plugin dirs:

```ts
          skills: {
            ...agentConfig.skills,
            paths: [...(agentConfig.skills?.paths ?? []), ...pluginSkillDirs],
          },
```

- [ ] **Step 6: Build + verify the whole gateway typechecks and tests pass**

Run: `npm run build -w packages/plugin-sdk -w packages/plugins -w apps/gateway`
Run: `npx vitest run apps/gateway/src/plugins-wiring.test.ts`
Expected: PASS.
Run: `npm run lint`
Expected: clean (Biome + typechecks).

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/index.ts apps/gateway/package.json \
  apps/gateway/src/plugins-wiring.test.ts package-lock.json
git commit -m "feat(gateway): load Claude Code plugins and route their skills to agents"
```

---

## Task 8 — Full verification + docs

**Files:**
- Modify: `docs/configuration.mdx` (user-facing: how to add a plugin)

- [ ] **Step 1: Run the full local gate**

Run: `npm run lint && npm run build && npm test`
Expected: all pass. (This is the pre-push gate from CLAUDE.md.)

- [ ] **Step 2: Manual smoke** — drop a real plugin and confirm it loads:

```bash
mkdir -p /tmp/dash-data/plugins/superpowers-skills/skills/hello
printf '%s\n' '---' 'name: hello' 'description: say hello' '---' 'Greet warmly.' \
  > /tmp/dash-data/plugins/superpowers-skills/skills/hello/SKILL.md
printf '%s\n' '{ "superpowers-skills": { "enabled": true } }' \
  > /tmp/dash-data/plugins/config.json
npm run gateway -- --data-dir /tmp/dash-data --verbose
```

Expected: gateway logs `[plugins] loaded 'superpowers-skills' (skills)` and an agent's `/skills` lists `hello`.

- [ ] **Step 3: Update docs.** Add a short "Plugins" subsection to `docs/configuration.mdx` documenting: plugins live in `<dataDir>/plugins/<name>/` (Claude Code layout — `.claude-plugin/plugin.json` + `skills/`); enable one by adding `{ "<name>": { "enabled": true } }` to `<dataDir>/plugins/config.json`; only `skills/` is active in this release (more components to come). Keep it practical, copy-pasteable, non-developer-facing per the docs tone guide.

- [ ] **Step 4: Commit**

```bash
git add docs/configuration.mdx
git commit -m "docs(config): document on-disk plugin discovery and enabling"
```

---

## Self-review (completed)

1. **Spec coverage (Plan 1 slice):** loader ✓ (Task 5), marketplace/install-state — *deferred, noted in Scope*; skills ✓ (Tasks 3,5,7); commands/MCP/hooks/subagents/providers — *deferred to Plans 2–5, noted*; trust gate ✓ (Task 4, enable-only enforcement this plan, documented); plugin runtime/path-vars — *deferred to Plan 3, noted*; include/exclude — Plan 1 only touches skills, no excluded component is wrongly activated.
2. **Placeholder scan:** none — every code step has complete code; no "TBD"/"add error handling".
3. **Type consistency:** `PluginManifest.skills` is `string[]` (normalized in `validateManifest`); `resolveSkillDirs`/`loadPlugins`/`LoadedPlugins.skillDirs` all use it consistently. `PluginRecord` shape identical across Tasks 2/5/7. `loadPlugins` options (`pluginsDir`, `entries`) match the gateway call in Task 7.
4. **Deferrals are explicit**, so no spec requirement is silently dropped.
