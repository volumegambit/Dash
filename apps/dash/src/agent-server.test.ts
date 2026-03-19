import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock all external modules before importing the module under test
vi.mock('@dash/agent', () => {
  const PiAgentBackend = vi.fn();
  PiAgentBackend.prototype.start = vi.fn().mockResolvedValue(undefined);
  PiAgentBackend.prototype.stop = vi.fn().mockResolvedValue(undefined);

  const DashAgent = vi.fn();

  const LocalAgentClient = vi.fn().mockImplementation((agent) => ({ agent }));

  const FileLogger = {
    create: vi.fn().mockResolvedValue({
      info: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  };

  const generateFrontmatter = vi.fn().mockReturnValue('---\nname: test\n---\n\ncontent');

  return { PiAgentBackend, DashAgent, LocalAgentClient, FileLogger, generateFrontmatter };
});

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

import { LocalAgentClient, PiAgentBackend } from '@dash/agent';
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

describe('createAgentServer startup isolation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts successfully when all agents succeed', async () => {
    const config = makeConfig({
      alpha: { model: 'claude-test', systemPrompt: 'Alpha' },
      beta: { model: 'claude-test', systemPrompt: 'Beta' },
    });

    const server = await createAgentServer(config);
    expect(server).toBeDefined();
    expect(typeof server.start).toBe('function');
    expect(typeof server.stop).toBe('function');
  });

  it('starts with remaining agent when one of two agents fails to start', async () => {
    const MockBackend = PiAgentBackend as unknown as ReturnType<typeof vi.fn>;

    let callCount = 0;
    MockBackend.mockImplementation(() => {
      callCount++;
      const instance = {
        start:
          callCount === 1
            ? vi.fn().mockRejectedValue(new Error('connection refused'))
            : vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      };
      return instance;
    });

    const config = makeConfig({
      failing: { model: 'claude-test', systemPrompt: 'Fails' },
      working: { model: 'claude-test', systemPrompt: 'Works' },
    });

    // Should not throw
    const server = await createAgentServer(config);
    expect(server).toBeDefined();

    // Only the surviving (working) agent should have a client registered
    const MockLocalAgentClient = LocalAgentClient as unknown as ReturnType<typeof vi.fn>;
    expect(MockLocalAgentClient).toHaveBeenCalledTimes(1);
  });

  it('throws when all agents fail to start', async () => {
    const MockBackend = PiAgentBackend as unknown as ReturnType<typeof vi.fn>;

    MockBackend.mockImplementation(() => ({
      start: vi.fn().mockRejectedValue(new Error('startup error')),
      stop: vi.fn().mockResolvedValue(undefined),
    }));

    const config = makeConfig({
      agentA: { model: 'claude-test', systemPrompt: 'A' },
      agentB: { model: 'claude-test', systemPrompt: 'B' },
    });

    await expect(createAgentServer(config)).rejects.toThrow(
      'All agents failed to start: agentA, agentB',
    );
  });
});
