/**
 * Contract test for the pi-coding-agent + pi-ai SDK surfaces that
 * PiAgentBackend depends on.
 *
 * Unlike `piagent.test.ts`, this file does NOT mock the SDK — it imports
 * the real modules and verifies the specific exports, types, and return
 * shapes our backend relies on. If either SDK package is upgraded and
 * silently renames a method or changes a return shape, the mocked tests
 * will still pass but this file will fail.
 *
 * Scope deliberately limited to:
 * 1. Named exports exist and are the right kind (function / class)
 * 2. Static constructors (`AuthStorage.inMemory`, `SessionManager.inMemory`,
 *    `SessionManager.continueRecent`) return objects with the methods we call
 * 3. `new DefaultResourceLoader(...)` has the methods `DashResourceLoader`
 *    delegates to
 *
 * Deliberately OUT of scope (would require API keys or non-trivial setup):
 * - Actually calling `createAgentSession` — just verify it's a function
 * - Actually running a model via `getModel(...).generate(...)`
 */
import { describe, expect, it } from 'vitest';

import { getModel } from '@mariozechner/pi-ai';
import type { Api, Model } from '@mariozechner/pi-ai';
// If any of these imports change name, TypeScript compilation fails before
// the test runner even starts — which is itself a fast-failing contract check.
import {
  AuthStorage,
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from '@mariozechner/pi-coding-agent';
// Type-only imports — any rename here is caught at compile time too.
import type {
  AgentSession,
  AgentSessionEvent,
  ResourceLoader,
  Skill,
} from '@mariozechner/pi-coding-agent';

describe('pi-coding-agent SDK contract', () => {
  it('exports createAgentSession as a function', () => {
    expect(typeof createAgentSession).toBe('function');
  });

  it('exports AuthStorage with a static inMemory() factory', () => {
    expect(AuthStorage).toBeDefined();
    expect(typeof AuthStorage.inMemory).toBe('function');
  });

  it('AuthStorage.inMemory() returns an object with set/get/list/remove methods', () => {
    const storage = AuthStorage.inMemory();
    expect(typeof storage.set).toBe('function');
    expect(typeof storage.get).toBe('function');
    expect(typeof storage.list).toBe('function');
    expect(typeof storage.remove).toBe('function');
  });

  it('AuthStorage round-trips an api_key credential via set / get / remove', () => {
    const storage = AuthStorage.inMemory();
    storage.set('anthropic', { type: 'api_key', key: 'sk-test' });
    expect(storage.list()).toContain('anthropic');

    const cred = storage.get('anthropic');
    expect(cred).toMatchObject({ type: 'api_key', key: 'sk-test' });

    storage.remove('anthropic');
    expect(storage.list()).not.toContain('anthropic');
  });

  it('AuthStorage accepts an oauth credential shape without throwing', () => {
    // PiAgentBackend.applyKeysToAuth() sets credentials with this exact
    // shape when `isOAuthToken(key)` is true. If the SDK renames the
    // fields, our auth code will silently set undefined values — this
    // test guards against that.
    const storage = AuthStorage.inMemory();
    expect(() =>
      storage.set('anthropic', {
        type: 'oauth',
        access: 'sk-ant-oat01-test',
        refresh: '',
        expires: Date.now() + 60_000,
      }),
    ).not.toThrow();
  });

  it('exports SessionManager with inMemory() and continueRecent() factories', () => {
    expect(SessionManager).toBeDefined();
    expect(typeof SessionManager.inMemory).toBe('function');
    expect(typeof SessionManager.continueRecent).toBe('function');
  });

  it('SessionManager.inMemory() returns a non-null object', () => {
    const sm = SessionManager.inMemory();
    expect(sm).toBeDefined();
    expect(sm).not.toBeNull();
  });

  it('SessionManager.continueRecent(cwd, dir) returns a non-null object', () => {
    // PiAgentBackend calls this with (workspace, sessionDir). The SDK may
    // read from the sessionDir path, so we use a temp-ish path that won't
    // exist but shouldn't throw at construction time.
    const sm = SessionManager.continueRecent('/tmp/contract-test-workspace', '/tmp/does-not-exist');
    expect(sm).toBeDefined();
  });

  it('exports DefaultResourceLoader as a constructable class', () => {
    expect(DefaultResourceLoader).toBeDefined();
    expect(typeof DefaultResourceLoader).toBe('function');
  });

  it('new DefaultResourceLoader(opts) produces an object with the ResourceLoader interface', () => {
    // DashResourceLoader wraps a DefaultResourceLoader and delegates these
    // methods. If any are renamed, DashResourceLoader silently breaks.
    const loader = new DefaultResourceLoader({
      cwd: '/tmp/contract-test-workspace',
      noSkills: true,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
    });

    expect(typeof loader.reload).toBe('function');
    expect(typeof loader.getSkills).toBe('function');
    expect(typeof loader.getSystemPrompt).toBe('function');
    expect(typeof loader.getAppendSystemPrompt).toBe('function');
    expect(typeof loader.getExtensions).toBe('function');
    expect(typeof loader.getPrompts).toBe('function');
    expect(typeof loader.getThemes).toBe('function');
    expect(typeof loader.getAgentsFiles).toBe('function');
    expect(typeof loader.extendResources).toBe('function');
  });

  it('DefaultResourceLoader.getSkills() returns { skills, diagnostics } when noSkills is true', () => {
    const loader = new DefaultResourceLoader({
      cwd: '/tmp/contract-test-workspace',
      noSkills: true,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    const result = loader.getSkills();
    expect(result).toHaveProperty('skills');
    expect(result).toHaveProperty('diagnostics');
    expect(Array.isArray(result.skills)).toBe(true);
  });

  it('exports all built-in tool factories as functions', () => {
    // PiAgentBackend.buildBuiltinTools() calls these by name. If any
    // disappear or get renamed, the backend silently omits that tool.
    expect(typeof createBashTool).toBe('function');
    expect(typeof createEditTool).toBe('function');
    expect(typeof createFindTool).toBe('function');
    expect(typeof createGrepTool).toBe('function');
    expect(typeof createLsTool).toBe('function');
    expect(typeof createReadTool).toBe('function');
    expect(typeof createWriteTool).toBe('function');
  });

  it('tool factories return objects with a name property', () => {
    const bash = createBashTool('/tmp');
    const read = createReadTool('/tmp');
    expect(typeof bash.name).toBe('string');
    expect(typeof read.name).toBe('string');
    // These specific names are relied on by PiAgentBackend's allowedNames
    // set — if they change, tool filtering breaks silently.
    expect(bash.name).toBe('bash');
    expect(read.name).toBe('read');
  });
});

describe('pi-ai SDK contract', () => {
  it('exports getModel as a function', () => {
    expect(typeof getModel).toBe('function');
  });

  it('getModel("anthropic", "claude-sonnet-4-5") returns a Model with an id field', () => {
    // This model must exist in the registry — it's the default in several
    // Dash test fixtures. If pi-ai drops it from the built-in list, tests
    // and production config both need updating.
    const model = getModel('anthropic', 'claude-sonnet-4-5');
    expect(model).toBeDefined();
    // The `satisfies` check below asserts the type surface at compile time;
    // this line asserts the runtime presence of the id field.
    expect(typeof (model as unknown as { id: string }).id).toBe('string');
  });

  it('getModel returns a distinct Model object per (provider, modelId) pair', () => {
    const a = getModel('anthropic', 'claude-sonnet-4-5');
    const b = getModel('anthropic', 'claude-opus-4-5');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    const aId = (a as unknown as { id: string }).id;
    const bId = (b as unknown as { id: string }).id;
    // Even if the id format changes, two different model IDs must not
    // collapse to the same object — PiAgentBackend.resolveModel relies
    // on this to pick the right model per agent.
    expect(aId).not.toBe(bId);
  });
});

// ── Type-level assertions ────────────────────────────────────────────────
//
// These `satisfies` expressions are evaluated at TypeScript compile time —
// if the type shape changes in the SDK, `tsup` / `tsc` fails before the
// test runner ever starts. They're wrapped in an `it()` so biome's
// `noExportsInTest` rule doesn't fire; the runtime cost is zero.

describe('pi-coding-agent SDK type surface', () => {
  it('locks in the Skill shape that PiAgentBackend.listSkillsAsPiSkills constructs', () => {
    // If the SDK renames any field, this line fails to compile.
    const skill = {
      name: '',
      description: '',
      filePath: '',
      baseDir: '',
      sourceInfo: {
        path: '',
        source: 'managed',
        scope: 'temporary' as const,
        origin: 'top-level' as const,
      },
      disableModelInvocation: false,
    } satisfies Skill;

    expect(skill.name).toBe('');
    expect(skill.sourceInfo.source).toBe('managed');
  });

  it('locks in the type imports used by piagent.ts', () => {
    // These assignments exist purely to force the compiler to evaluate
    // the type imports. If any of these types are renamed or removed
    // from the SDK, the file fails to compile.
    const session: AgentSession | undefined = undefined;
    const event: AgentSessionEvent | undefined = undefined;
    const loader: ResourceLoader | undefined = undefined;
    const model: Model<Api> | undefined = undefined;
    expect(session).toBeUndefined();
    expect(event).toBeUndefined();
    expect(loader).toBeUndefined();
    expect(model).toBeUndefined();
  });
});
