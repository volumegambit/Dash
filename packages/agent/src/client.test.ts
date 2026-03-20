import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PooledAgentClient } from './client.js';
import type { BackendFactory } from './client.js';
import type { AgentBackend, AgentEvent, DashAgentConfig } from './types.js';

// --- Mock backend factory ---

const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockUpdateCredentials = vi.fn().mockResolvedValue(undefined);
const mockAnswerQuestion = vi.fn().mockResolvedValue(undefined);
const mockSteer = vi.fn().mockResolvedValue(undefined);
const mockFollowUp = vi.fn().mockResolvedValue(undefined);

function createMockBackend(): AgentBackend {
  return {
    name: 'mock',
    start: mockStart,
    stop: mockStop,
    run: vi.fn(),
    abort: vi.fn(),
    updateCredentials: mockUpdateCredentials,
    answerQuestion: mockAnswerQuestion,
    steer: mockSteer,
    followUp: mockFollowUp,
  };
}

/** Tracks all calls to the factory: [config, keys, sessionDir] */
const factoryCalls: [DashAgentConfig, Record<string, string>, string][] = [];

const mockFactory: BackendFactory = (config, keys, sessionDir) => {
  factoryCalls.push([config, keys, sessionDir]);
  return createMockBackend();
};

// --- Mock DashAgent ---

const mockChatEvents: AgentEvent[] = [
  { type: 'text_delta', text: 'hello' },
  {
    type: 'response',
    content: 'hello',
    usage: { inputTokens: 10, outputTokens: 5 },
  },
];

const mockUpdateConfig = vi.fn();

vi.mock('./agent.js', () => ({
  DashAgent: vi.fn().mockImplementation(() => ({
    chat: vi.fn().mockImplementation(async function* () {
      for (const event of mockChatEvents) {
        yield event;
      }
    }),
    updateConfig: mockUpdateConfig,
    answerQuestion: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Import mocked constructor for assertions
import { DashAgent as MockedDashAgent } from './agent.js';

// --- PooledAgentClient tests ---

describe('PooledAgentClient', () => {
  let tmpDir: string;
  const agentConfig: DashAgentConfig = {
    model: 'anthropic/claude-sonnet-4-20250514',
    systemPrompt: 'You are a test agent',
    tools: ['read', 'bash'],
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'pooled-client-test-'));
    vi.clearAllMocks();
    factoryCalls.length = 0;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createClient(workspace?: string) {
    return new PooledAgentClient(
      { ...agentConfig },
      { anthropic: 'sk-test-key' },
      tmpDir,
      mockFactory,
      workspace ?? '/tmp/workspace',
    );
  }

  it('creates a new backend on first message (pool miss)', async () => {
    const client = createClient();
    const events: AgentEvent[] = [];

    for await (const event of client.chat('ch-1', 'conv-1', 'hi')) {
      events.push(event);
    }

    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0][0]).toEqual(expect.objectContaining({ model: agentConfig.model }));
    expect(factoryCalls[0][1]).toEqual({ anthropic: 'sk-test-key' });
    expect(factoryCalls[0][2]).toBe(join(tmpDir, 'conv-1'));
    expect(mockStart).toHaveBeenCalledWith('/tmp/workspace');
    expect(MockedDashAgent).toHaveBeenCalledOnce();
    expect(events).toEqual(mockChatEvents);
  });

  it('reuses backend on subsequent messages (pool hit)', async () => {
    const client = createClient();

    // First message
    for await (const _ of client.chat('ch-1', 'conv-1', 'first')) {
      // consume
    }

    // Second message — same conversationId
    for await (const _ of client.chat('ch-1', 'conv-1', 'second')) {
      // consume
    }

    // Backend + Agent should only be created once
    expect(factoryCalls).toHaveLength(1);
    expect(MockedDashAgent).toHaveBeenCalledOnce();
    expect(mockStart).toHaveBeenCalledOnce();
  });

  it('creates separate backends for different conversationIds', async () => {
    const client = createClient();

    for await (const _ of client.chat('ch-1', 'conv-A', 'hello A')) {
      // consume
    }
    for await (const _ of client.chat('ch-1', 'conv-B', 'hello B')) {
      // consume
    }

    expect(factoryCalls).toHaveLength(2);
    expect(MockedDashAgent).toHaveBeenCalledTimes(2);

    // Verify different session directories
    expect(factoryCalls[0][2]).toBe(join(tmpDir, 'conv-A'));
    expect(factoryCalls[1][2]).toBe(join(tmpDir, 'conv-B'));
  });

  it('stop() disposes all backends and clears pool', async () => {
    const client = createClient();

    // Create two entries
    for await (const _ of client.chat('ch-1', 'conv-1', 'hi')) {
      // consume
    }
    for await (const _ of client.chat('ch-1', 'conv-2', 'hi')) {
      // consume
    }

    await client.stop();

    expect(mockStop).toHaveBeenCalledTimes(2);

    // After stop, next chat should create a fresh backend
    factoryCalls.length = 0;
    vi.clearAllMocks();
    for await (const _ of client.chat('ch-1', 'conv-1', 'hi again')) {
      // consume
    }
    expect(factoryCalls).toHaveLength(1);
  });

  it('updateCredentials() propagates to all existing backends', async () => {
    const client = createClient();

    // Create two entries
    for await (const _ of client.chat('ch-1', 'conv-1', 'hi')) {
      // consume
    }
    for await (const _ of client.chat('ch-1', 'conv-2', 'hi')) {
      // consume
    }

    const newKeys = { anthropic: 'sk-new-key' };
    await client.updateCredentials(newKeys);

    expect(mockUpdateCredentials).toHaveBeenCalledTimes(2);
    expect(mockUpdateCredentials).toHaveBeenCalledWith(newKeys);
  });

  it('updateConfig() propagates to all existing agents AND stores for future backends', async () => {
    const client = createClient();

    // Create one entry
    for await (const _ of client.chat('ch-1', 'conv-1', 'hi')) {
      // consume
    }

    const patch = { model: 'anthropic/claude-haiku-3-20250714' };
    client.updateConfig(patch);

    // Existing agent receives the update
    expect(mockUpdateConfig).toHaveBeenCalledWith(patch);

    // New backend should use the updated model
    factoryCalls.length = 0;
    vi.clearAllMocks();
    for await (const _ of client.chat('ch-1', 'conv-new', 'hi')) {
      // consume
    }

    // The factory should receive the updated config
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0][0]).toEqual(
      expect.objectContaining({ model: 'anthropic/claude-haiku-3-20250714' }),
    );
  });

  it('answerQuestion() broadcasts to all backends', async () => {
    const client = createClient();

    // Create two entries
    for await (const _ of client.chat('ch-1', 'conv-1', 'hi')) {
      // consume
    }
    for await (const _ of client.chat('ch-1', 'conv-2', 'hi')) {
      // consume
    }

    await client.answerQuestion('q-1', [['yes']]);

    expect(mockAnswerQuestion).toHaveBeenCalledTimes(2);
    expect(mockAnswerQuestion).toHaveBeenCalledWith('q-1', [['yes']]);
  });

  it('passes current keys to factory for each new conversation', async () => {
    const client = createClient();

    for await (const _ of client.chat('ch-1', 'conv-1', 'hi')) {
      // consume
    }

    expect(factoryCalls[0][1]).toEqual({ anthropic: 'sk-test-key' });

    // Update keys, then create a new conversation
    await client.updateCredentials({ anthropic: 'sk-new-key' });
    for await (const _ of client.chat('ch-1', 'conv-2', 'hi')) {
      // consume
    }

    expect(factoryCalls[1][1]).toEqual({ anthropic: 'sk-new-key' });
  });

  it('uses process.cwd() when workspace is not provided', async () => {
    const client = new PooledAgentClient(
      { ...agentConfig },
      { anthropic: 'sk-test-key' },
      tmpDir,
      mockFactory,
    );

    for await (const _ of client.chat('ch-1', 'conv-1', 'hi')) {
      // consume
    }

    expect(mockStart).toHaveBeenCalledWith(process.cwd());
  });

  describe('steer / followUp', () => {
    it('steer() delegates to backend for existing conversation', async () => {
      const client = new PooledAgentClient(
        { ...agentConfig },
        { anthropic: 'sk-test-key' },
        tmpDir,
        mockFactory,
      );
      const stream = client.chat('ch', 'conv-1', 'hello');
      for await (const _ of stream) {
        /* drain */
      }

      await client.steer('conv-1', 'new direction');
      // biome-ignore lint/suspicious/noExplicitAny: accessing private pool for test verification
      const entry = (client as any).pool.get('conv-1');
      expect(entry.backend.steer).toHaveBeenCalledWith('new direction', undefined);
    });

    it('steer() throws if conversation not found', async () => {
      const client = new PooledAgentClient(
        { ...agentConfig },
        { anthropic: 'sk-test-key' },
        tmpDir,
        mockFactory,
      );
      await expect(client.steer('nonexistent', 'text')).rejects.toThrow('No active conversation');
    });

    it('steer() throws if backend does not support steering', async () => {
      const noSteerFactory: BackendFactory = (_config, _keys, _sessionDir) => {
        const backend = createMockBackend();
        // biome-ignore lint/suspicious/noExplicitAny: removing optional methods for test
        (backend as any).steer = undefined;
        // biome-ignore lint/suspicious/noExplicitAny: removing optional methods for test
        (backend as any).followUp = undefined;
        return backend;
      };
      const client = new PooledAgentClient(
        { ...agentConfig },
        { anthropic: 'sk-test-key' },
        tmpDir,
        noSteerFactory,
      );
      const stream = client.chat('ch', 'conv-1', 'hello');
      for await (const _ of stream) {
        /* drain */
      }
      await expect(client.steer('conv-1', 'text')).rejects.toThrow('does not support');
    });

    it('followUp() delegates to backend for existing conversation', async () => {
      const client = new PooledAgentClient(
        { ...agentConfig },
        { anthropic: 'sk-test-key' },
        tmpDir,
        mockFactory,
      );
      const stream = client.chat('ch', 'conv-1', 'hello');
      for await (const _ of stream) {
        /* drain */
      }

      await client.followUp('conv-1', 'follow up text');
      // biome-ignore lint/suspicious/noExplicitAny: accessing private pool for test verification
      const entry = (client as any).pool.get('conv-1');
      expect(entry.backend.followUp).toHaveBeenCalledWith('follow up text', undefined);
    });
  });
});
