import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { AgentRegistry } from './agent-registry.js';

describe('AgentRegistry', () => {
  it('registers and retrieves an agent', () => {
    const registry = new AgentRegistry();
    const entry = registry.register({
      name: 'agent-a',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'You are helpful.',
    });

    const agent = registry.get(entry.id);
    expect(agent).toBeDefined();
    expect(agent?.name).toBe('agent-a');
    expect(agent?.status).toBe('registered');
  });

  it('assigns a unique id on register', () => {
    const registry = new AgentRegistry();
    const a = registry.register({ name: 'a', model: 'm', systemPrompt: 's' });
    const b = registry.register({ name: 'b', model: 'm', systemPrompt: 's' });
    expect(a.id).toBeDefined();
    expect(b.id).toBeDefined();
    expect(a.id).not.toBe(b.id);
    expect(a.id).toHaveLength(8);
  });

  it('preserves id across update', () => {
    const registry = new AgentRegistry();
    const entry = registry.register({ name: 'a', model: 'm1', systemPrompt: 's' });
    const updated = registry.update(entry.id, { model: 'm2' });
    expect(updated.id).toBe(entry.id);
  });

  it('can get agent by id', () => {
    const registry = new AgentRegistry();
    const entry = registry.register({ name: 'a', model: 'm', systemPrompt: 's' });
    expect(registry.get(entry.id)).toBe(entry);
  });

  it('get by name returns undefined', () => {
    const registry = new AgentRegistry();
    registry.register({ name: 'a', model: 'm', systemPrompt: 's' });
    expect(registry.get('a')).toBeUndefined();
  });

  it('findByName returns the agent', () => {
    const registry = new AgentRegistry();
    const entry = registry.register({ name: 'agent-x', model: 'm', systemPrompt: 's' });
    const found = registry.findByName('agent-x');
    expect(found).toBeDefined();
    expect(found?.id).toBe(entry.id);
    expect(registry.findByName('nonexistent')).toBeUndefined();
  });

  it('rejects duplicate names', () => {
    const registry = new AgentRegistry();
    registry.register({
      name: 'agent-a',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'test',
    });
    expect(() =>
      registry.register({
        name: 'agent-a',
        model: 'anthropic/claude-sonnet-4-20250514',
        systemPrompt: 'test',
      }),
    ).toThrow(/already registered/);
  });

  it('lists all agents', () => {
    const registry = new AgentRegistry();
    registry.register({ name: 'a', model: 'm', systemPrompt: 's' });
    registry.register({ name: 'b', model: 'm', systemPrompt: 's' });
    expect(registry.list().map((a) => a.name)).toEqual(['a', 'b']);
  });

  it('removes an agent', () => {
    const registry = new AgentRegistry();
    const entry = registry.register({ name: 'a', model: 'm', systemPrompt: 's' });
    registry.remove(entry.id);
    expect(registry.get(entry.id)).toBeUndefined();
  });

  it('updates agent config', () => {
    const registry = new AgentRegistry();
    const entry = registry.register({ name: 'a', model: 'm1', systemPrompt: 's' });
    registry.update(entry.id, { model: 'm2' });
    expect(registry.get(entry.id)?.config.model).toBe('m2');
  });

  it('supports disabled state', () => {
    const registry = new AgentRegistry();
    const entry = registry.register({ name: 'a', model: 'm', systemPrompt: 's' });
    registry.disable(entry.id);
    expect(registry.get(entry.id)?.status).toBe('disabled');
    registry.enable(entry.id);
    expect(registry.get(entry.id)?.status).toBe('registered');
  });

  it('has() returns true for registered agents', () => {
    const registry = new AgentRegistry();
    const entry = registry.register({ name: 'a', model: 'm', systemPrompt: 's' });
    expect(registry.has(entry.id)).toBe(true);
    expect(registry.has('nonexistent-id')).toBe(false);
  });

  it('setActive transitions registered to active', () => {
    const registry = new AgentRegistry();
    const entry = registry.register({ name: 'a', model: 'm', systemPrompt: 's' });
    registry.setActive(entry.id);
    expect(registry.get(entry.id)?.status).toBe('active');
  });

  it('setActive does not transition disabled to active', () => {
    const registry = new AgentRegistry();
    const entry = registry.register({ name: 'a', model: 'm', systemPrompt: 's' });
    registry.disable(entry.id);
    registry.setActive(entry.id);
    expect(registry.get(entry.id)?.status).toBe('disabled');
  });

  it('update throws for unknown agent', () => {
    const registry = new AgentRegistry();
    expect(() => registry.update('nope', { model: 'm' })).toThrow(/not found/);
  });

  it('disable throws for unknown agent', () => {
    const registry = new AgentRegistry();
    expect(() => registry.disable('nope')).toThrow(/not found/);
  });

  it('enable throws for unknown agent', () => {
    const registry = new AgentRegistry();
    expect(() => registry.enable('nope')).toThrow(/not found/);
  });
});

describe('AgentRegistry (file-backed)', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-reg-'));
    filePath = join(dir, 'agents.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists on save and restores on load', async () => {
    const reg = new AgentRegistry(filePath);
    const entry = reg.register({ name: 'a', model: 'm', systemPrompt: 's' });
    await reg.save();

    const reg2 = new AgentRegistry(filePath);
    await reg2.load();
    expect(reg2.get(entry.id)?.config.model).toBe('m');
  });

  it('persists updates', async () => {
    const reg = new AgentRegistry(filePath);
    const entry = reg.register({ name: 'a', model: 'm1', systemPrompt: 's' });
    await reg.save();

    reg.update(entry.id, { model: 'm2' });
    await reg.save();

    const reg2 = new AgentRegistry(filePath);
    await reg2.load();
    expect(reg2.get(entry.id)?.config.model).toBe('m2');
  });

  it('persists removes', async () => {
    const reg = new AgentRegistry(filePath);
    const entry = reg.register({ name: 'a', model: 'm', systemPrompt: 's' });
    await reg.save();

    reg.remove(entry.id);
    await reg.save();

    const reg2 = new AgentRegistry(filePath);
    await reg2.load();
    expect(reg2.list()).toEqual([]);
  });

  it('preserves status and registeredAt across save/load', async () => {
    const reg = new AgentRegistry(filePath);
    const entry = reg.register({ name: 'a', model: 'm', systemPrompt: 's' });
    reg.disable(entry.id);
    await reg.save();

    const reg2 = new AgentRegistry(filePath);
    await reg2.load();
    expect(reg2.get(entry.id)?.status).toBe('disabled');
    expect(reg2.get(entry.id)?.registeredAt).toBe(reg.get(entry.id)?.registeredAt);
  });

  it('works without a file path (in-memory only)', () => {
    const reg = new AgentRegistry();
    const entry = reg.register({ name: 'a', model: 'm', systemPrompt: 's' });
    expect(reg.get(entry.id)).toBeDefined();
  });

  it('save is a no-op without a file path', async () => {
    const reg = new AgentRegistry();
    reg.register({ name: 'a', model: 'm', systemPrompt: 's' });
    await reg.save(); // should not throw
  });

  it('load is a no-op when file does not exist', async () => {
    const reg = new AgentRegistry(filePath);
    await reg.load();
    expect(reg.list()).toEqual([]);
  });

  describe('patchMcpServers', () => {
    it('adds a new server, starting from no mcpServers', () => {
      const reg = new AgentRegistry();
      const entry = reg.register({ name: 'a', model: 'm', systemPrompt: 's' });
      reg.patchMcpServers(entry.id, 'add', 'server-1');
      expect(reg.get(entry.id)?.config.mcpServers).toEqual(['server-1']);
    });

    it('adds to an existing list', () => {
      const reg = new AgentRegistry();
      const entry = reg.register({
        name: 'a',
        model: 'm',
        systemPrompt: 's',
        mcpServers: ['server-1'],
      });
      reg.patchMcpServers(entry.id, 'add', 'server-2');
      expect(reg.get(entry.id)?.config.mcpServers).toEqual(['server-1', 'server-2']);
    });

    it('is idempotent on add (no duplicates)', () => {
      const reg = new AgentRegistry();
      const entry = reg.register({
        name: 'a',
        model: 'm',
        systemPrompt: 's',
        mcpServers: ['server-1'],
      });
      reg.patchMcpServers(entry.id, 'add', 'server-1');
      expect(reg.get(entry.id)?.config.mcpServers).toEqual(['server-1']);
    });

    it('removes an existing server', () => {
      const reg = new AgentRegistry();
      const entry = reg.register({
        name: 'a',
        model: 'm',
        systemPrompt: 's',
        mcpServers: ['server-1', 'server-2'],
      });
      reg.patchMcpServers(entry.id, 'remove', 'server-1');
      expect(reg.get(entry.id)?.config.mcpServers).toEqual(['server-2']);
    });

    it('is idempotent on remove (missing server is fine)', () => {
      const reg = new AgentRegistry();
      const entry = reg.register({
        name: 'a',
        model: 'm',
        systemPrompt: 's',
        mcpServers: ['server-1'],
      });
      reg.patchMcpServers(entry.id, 'remove', 'ghost');
      expect(reg.get(entry.id)?.config.mcpServers).toEqual(['server-1']);
    });

    it('throws for unknown agent id', () => {
      const reg = new AgentRegistry();
      expect(() => reg.patchMcpServers('nope', 'add', 'server-1')).toThrow("'nope' not found");
    });
  });

  describe('defaultWorkspace resolver', () => {
    it('assigns the resolver result when the caller omits workspace', () => {
      const resolverCalls: string[] = [];
      const reg = new AgentRegistry(undefined, {
        defaultWorkspace: (id) => {
          resolverCalls.push(id);
          return `/var/dash/workspaces/${id}`;
        },
      });

      const entry = reg.register({
        name: 'needs-default',
        model: 'anthropic/claude-sonnet-4-5',
        systemPrompt: 's',
      });

      // The resolver was invoked once, with the freshly-assigned ID
      expect(resolverCalls).toEqual([entry.id]);
      // The registry stored the resolved path, not undefined
      expect(entry.config.workspace).toBe(`/var/dash/workspaces/${entry.id}`);
      // A subsequent read returns the same path
      expect(reg.get(entry.id)?.config.workspace).toBe(`/var/dash/workspaces/${entry.id}`);
    });

    it('also defaults when the caller passes an empty string workspace', () => {
      // Some non-MC callers (curl, test scripts) may pass workspace:''
      // directly rather than omitting the field. We treat '' the same as
      // undefined so the default path is applied either way.
      const reg = new AgentRegistry(undefined, {
        defaultWorkspace: (id) => `/var/dash/workspaces/${id}`,
      });

      const entry = reg.register({
        name: 'blank-workspace',
        model: 'm',
        systemPrompt: 's',
        workspace: '',
      });

      expect(entry.config.workspace).toBe(`/var/dash/workspaces/${entry.id}`);
    });

    it('preserves an explicit workspace verbatim and never calls the resolver', () => {
      const resolver = vi.fn((id: string) => `/should-not-be-used/${id}`);
      const reg = new AgentRegistry(undefined, { defaultWorkspace: resolver });

      const entry = reg.register({
        name: 'explicit',
        model: 'm',
        systemPrompt: 's',
        workspace: '/home/alice/my-project',
      });

      expect(entry.config.workspace).toBe('/home/alice/my-project');
      expect(resolver).not.toHaveBeenCalled();
    });

    it('without a resolver, blank workspace stays undefined (legacy behavior)', () => {
      // This is the pre-resolver contract — callers that construct an
      // AgentRegistry without options (e.g. existing tests, CLI scripts
      // that don't care about per-agent workspaces) must keep getting
      // undefined so downstream `entry.config.workspace ?? '.'` fallbacks
      // still fire.
      const reg = new AgentRegistry();

      const entry = reg.register({
        name: 'no-resolver',
        model: 'm',
        systemPrompt: 's',
      });

      expect(entry.config.workspace).toBeUndefined();
    });

    it('persists the resolved workspace to disk and reloads it without re-resolving', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'agent-registry-workspace-'));
      const filePath = join(tmpDir, 'agents.json');
      try {
        let resolverCallCount = 0;
        const resolver = (id: string) => {
          resolverCallCount++;
          return `/persistent/workspaces/${id}`;
        };

        // First lifetime: register an agent with the resolver
        const reg1 = new AgentRegistry(filePath, { defaultWorkspace: resolver });
        const entry1 = reg1.register({
          name: 'persistent',
          model: 'm',
          systemPrompt: 's',
        });
        await reg1.save();
        expect(resolverCallCount).toBe(1);
        const expectedPath = `/persistent/workspaces/${entry1.id}`;
        expect(entry1.config.workspace).toBe(expectedPath);

        // Second lifetime: reload from disk with the SAME resolver
        const reg2 = new AgentRegistry(filePath, { defaultWorkspace: resolver });
        await reg2.load();
        const reloaded = reg2.get(entry1.id);

        // The workspace should survive the reload verbatim
        expect(reloaded?.config.workspace).toBe(expectedPath);
        // And the resolver must NOT have been called again on load — the
        // stored path is authoritative
        expect(resolverCallCount).toBe(1);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('uses a different resolved path for each registered agent (no collisions)', () => {
      const reg = new AgentRegistry(undefined, {
        defaultWorkspace: (id) => `/w/${id}`,
      });

      const a = reg.register({ name: 'a', model: 'm', systemPrompt: 's' });
      const b = reg.register({ name: 'b', model: 'm', systemPrompt: 's' });
      const c = reg.register({ name: 'c', model: 'm', systemPrompt: 's' });

      const paths = [a.config.workspace, b.config.workspace, c.config.workspace];
      expect(new Set(paths).size).toBe(3); // all distinct
      expect(paths.every((p) => p?.startsWith('/w/'))).toBe(true);
    });
  });
});
