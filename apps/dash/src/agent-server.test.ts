import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock all external modules before importing the module under test
vi.mock('@dash/agent', () => {
  const PooledAgentClient = vi.fn().mockImplementation(() => ({
    stop: vi.fn().mockResolvedValue(undefined),
    updateCredentials: vi.fn().mockResolvedValue(undefined),
    updateConfig: vi.fn(),
  }));

  const FileLogger = {
    create: vi.fn().mockResolvedValue({
      info: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  };

  const generateFrontmatter = vi.fn().mockReturnValue('---\nname: test\n---\n\ncontent');

  return { PooledAgentClient, FileLogger, generateFrontmatter };
});

vi.mock('@mariozechner/pi-coding-agent', () => ({
  loadSkillsFromDir: vi.fn().mockReturnValue({ skills: [], diagnostics: [] }),
}));

vi.mock('@dash/chat', () => ({
  startChatServer: vi.fn().mockReturnValue({ close: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock('@dash/management', () => ({
  startManagementServer: vi.fn().mockReturnValue({ close: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue('{}'),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { PooledAgentClient } from '@dash/agent';
import { createAgentServer } from './agent-server.js';
import type { DashConfig } from './config.js';

function makeConfig(agents: DashConfig['agents']): DashConfig {
  return {
    agents,
    providerApiKeys: {},
    managementPort: 0,
    chatPort: 0,
  } as unknown as DashConfig;
}

describe('createAgentServer startup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers all agents as PooledAgentClients', async () => {
    const config = makeConfig({
      alpha: { model: 'claude-test', systemPrompt: 'Alpha' },
      beta: { model: 'claude-test', systemPrompt: 'Beta' },
    });

    const server = await createAgentServer(config);
    expect(server).toBeDefined();
    expect(typeof server.start).toBe('function');
    expect(typeof server.stop).toBe('function');

    // One PooledAgentClient per agent
    const MockPooledClient = PooledAgentClient as unknown as ReturnType<typeof vi.fn>;
    expect(MockPooledClient).toHaveBeenCalledTimes(2);
  });

  it('does not fail at startup since backends are created lazily', async () => {
    // With PooledAgentClient, nothing starts eagerly — no startup failures possible
    const config = makeConfig({
      agentA: { model: 'claude-test', systemPrompt: 'A' },
      agentB: { model: 'claude-test', systemPrompt: 'B' },
    });

    const server = await createAgentServer(config);
    expect(server).toBeDefined();

    const MockPooledClient = PooledAgentClient as unknown as ReturnType<typeof vi.fn>;
    expect(MockPooledClient).toHaveBeenCalledTimes(2);
  });

  it('calls stop on all pooled clients when server is stopped', async () => {
    const config = makeConfig({
      alpha: { model: 'claude-test', systemPrompt: 'Alpha' },
    });

    const server = await createAgentServer(config);
    await server.stop();

    const MockPooledClient = PooledAgentClient as unknown as ReturnType<typeof vi.fn>;
    const instance = MockPooledClient.mock.results[0].value;
    expect(instance.stop).toHaveBeenCalledTimes(1);
  });
});
