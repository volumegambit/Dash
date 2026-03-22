import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from './agent-registry.js';

describe('AgentRegistry', () => {
  it('registers and retrieves an agent', () => {
    const registry = new AgentRegistry();
    registry.register({
      name: 'agent-a',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'You are helpful.',
    });

    const agent = registry.get('agent-a');
    expect(agent).toBeDefined();
    expect(agent?.name).toBe('agent-a');
    expect(agent?.status).toBe('registered');
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
    registry.register({ name: 'a', model: 'm', systemPrompt: 's' });
    registry.remove('a');
    expect(registry.get('a')).toBeUndefined();
  });

  it('updates agent config', () => {
    const registry = new AgentRegistry();
    registry.register({ name: 'a', model: 'm1', systemPrompt: 's' });
    registry.update('a', { model: 'm2' });
    expect(registry.get('a')?.config.model).toBe('m2');
  });

  it('supports disabled state', () => {
    const registry = new AgentRegistry();
    registry.register({ name: 'a', model: 'm', systemPrompt: 's' });
    registry.disable('a');
    expect(registry.get('a')?.status).toBe('disabled');
    registry.enable('a');
    expect(registry.get('a')?.status).toBe('registered');
  });

  it('has() returns true for registered agents', () => {
    const registry = new AgentRegistry();
    registry.register({ name: 'a', model: 'm', systemPrompt: 's' });
    expect(registry.has('a')).toBe(true);
    expect(registry.has('b')).toBe(false);
  });

  it('setActive transitions registered to active', () => {
    const registry = new AgentRegistry();
    registry.register({ name: 'a', model: 'm', systemPrompt: 's' });
    registry.setActive('a');
    expect(registry.get('a')?.status).toBe('active');
  });

  it('setActive does not transition disabled to active', () => {
    const registry = new AgentRegistry();
    registry.register({ name: 'a', model: 'm', systemPrompt: 's' });
    registry.disable('a');
    registry.setActive('a');
    expect(registry.get('a')?.status).toBe('disabled');
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
    reg.register({ name: 'a', model: 'm', systemPrompt: 's' });
    await reg.save();

    const reg2 = new AgentRegistry(filePath);
    await reg2.load();
    expect(reg2.get('a')?.config.model).toBe('m');
  });

  it('persists updates', async () => {
    const reg = new AgentRegistry(filePath);
    reg.register({ name: 'a', model: 'm1', systemPrompt: 's' });
    await reg.save();

    reg.update('a', { model: 'm2' });
    await reg.save();

    const reg2 = new AgentRegistry(filePath);
    await reg2.load();
    expect(reg2.get('a')?.config.model).toBe('m2');
  });

  it('persists removes', async () => {
    const reg = new AgentRegistry(filePath);
    reg.register({ name: 'a', model: 'm', systemPrompt: 's' });
    await reg.save();

    reg.remove('a');
    await reg.save();

    const reg2 = new AgentRegistry(filePath);
    await reg2.load();
    expect(reg2.list()).toEqual([]);
  });

  it('preserves status and registeredAt across save/load', async () => {
    const reg = new AgentRegistry(filePath);
    reg.register({ name: 'a', model: 'm', systemPrompt: 's' });
    reg.disable('a');
    await reg.save();

    const reg2 = new AgentRegistry(filePath);
    await reg2.load();
    expect(reg2.get('a')?.status).toBe('disabled');
    expect(reg2.get('a')?.registeredAt).toBe(reg.get('a')?.registeredAt);
  });

  it('works without a file path (in-memory only)', () => {
    const reg = new AgentRegistry();
    reg.register({ name: 'a', model: 'm', systemPrompt: 's' });
    expect(reg.get('a')).toBeDefined();
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
