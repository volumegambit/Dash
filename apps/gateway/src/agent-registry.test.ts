import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
