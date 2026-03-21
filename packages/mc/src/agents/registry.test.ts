import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentDeployment } from '../types.js';
import { AgentRegistry } from './registry.js';

describe('AgentRegistry', () => {
  let tempDir: string;
  let registry: AgentRegistry;

  const testDeployment: AgentDeployment = {
    id: 'test-1',
    name: 'test-agent',
    target: 'local',
    status: 'running',
    config: {
      target: 'local',
      agents: {
        default: {
          name: 'default',
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'You are a test agent.',
        },
      },
      channels: {},
    },
    createdAt: '2026-03-01T00:00:00Z',
    containerId: 'abc123',
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mc-registry-'));
    registry = new AgentRegistry(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it('lists empty when no deployments exist', async () => {
    const deployments = await registry.list();
    expect(deployments).toEqual([]);
  });

  it('adds and retrieves a deployment', async () => {
    await registry.add(testDeployment);

    const result = await registry.get('test-1');
    expect(result).toEqual(testDeployment);
  });

  it('lists all deployments', async () => {
    await registry.add(testDeployment);
    await registry.add({ ...testDeployment, id: 'test-2', name: 'second-agent' });

    const deployments = await registry.list();
    expect(deployments).toHaveLength(2);
  });

  it('throws when adding a duplicate id', async () => {
    await registry.add(testDeployment);
    await expect(registry.add(testDeployment)).rejects.toThrow('already exists');
  });

  it('updates a deployment', async () => {
    await registry.add(testDeployment);
    await registry.update('test-1', { status: 'stopped' });

    const result = await registry.get('test-1');
    expect(result?.status).toBe('stopped');
  });

  it('throws when updating non-existent deployment', async () => {
    await expect(registry.update('missing', { status: 'stopped' })).rejects.toThrow('not found');
  });

  it('removes a deployment', async () => {
    await registry.add(testDeployment);
    await registry.remove('test-1');

    const result = await registry.get('test-1');
    expect(result).toBeNull();
  });

  it('throws when removing non-existent deployment', async () => {
    await expect(registry.remove('missing')).rejects.toThrow('not found');
  });

  it('persists across instances', async () => {
    await registry.add(testDeployment);

    const newRegistry = new AgentRegistry(tempDir);
    const result = await newRegistry.get('test-1');
    expect(result).toEqual(testDeployment);
  });

  it('returns null for non-existent id', async () => {
    const result = await registry.get('non-existent');
    expect(result).toBeNull();
  });

  it('returns empty list when file is empty', async () => {
    await writeFile(join(tempDir, 'agents.json'), '');
    expect(await registry.list()).toEqual([]);
  });

  it('returns empty list when file contains truncated JSON', async () => {
    await writeFile(join(tempDir, 'agents.json'), '[{"id":"test-1"');
    expect(await registry.list()).toEqual([]);
  });

  it('returns empty list when file contains non-JSON content', async () => {
    await writeFile(join(tempDir, 'agents.json'), 'not json at all');
    expect(await registry.list()).toEqual([]);
  });
});
