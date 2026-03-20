import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashAgent } from './agent.js';
import { LocalAgentClient, PooledAgentClient } from './client.js';
import type { AgentEvent, DashAgentConfig } from './types.js';

// --- Mock PiAgentBackend ---

const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockUpdateCredentials = vi.fn().mockResolvedValue(undefined);
const mockAnswerQuestion = vi.fn().mockResolvedValue(undefined);

vi.mock('./backends/piagent.js', () => ({
  PiAgentBackend: vi.fn().mockImplementation(() => ({
    start: mockStart,
    stop: mockStop,
    updateCredentials: mockUpdateCredentials,
    answerQuestion: mockAnswerQuestion,
  })),
}));

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

// Import mocked constructors for assertions
import { DashAgent as MockedDashAgent } from './agent.js';
import { PiAgentBackend as MockedPiAgentBackend } from './backends/piagent.js';

// --- LocalAgentClient tests ---

describe('LocalAgentClient', () => {
  it('delegates chat() to the underlying agent', async () => {
    const expectedEvents: AgentEvent[] = [
      { type: 'text_delta', text: 'Hello' },
      {
        type: 'response',
        content: 'Hello',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ];

    // Create a fake DashAgent with an async generator chat method
    const fakeAgent = {
      async *chat(
        _channelId: string,
        _conversationId: string,
        _text: string,
      ): AsyncGenerator<AgentEvent> {
        for (const event of expectedEvents) {
          yield event;
        }
      },
    } as unknown as DashAgent;

    const client = new LocalAgentClient(fakeAgent);
    const events: AgentEvent[] = [];

    for await (const event of client.chat('channel-1', 'conv-1', 'Hi')) {
      events.push(event);
    }

    expect(events).toEqual(expectedEvents);
  });

  it('passes channelId, conversationId, and text through', async () => {
    let receivedArgs: [string, string, string] | undefined;

    const fakeAgent = {
      // biome-ignore lint/correctness/useYield: test stub that captures args without yielding
      async *chat(
        channelId: string,
        conversationId: string,
        text: string,
      ): AsyncGenerator<AgentEvent> {
        receivedArgs = [channelId, conversationId, text];
      },
    } as unknown as DashAgent;

    const client = new LocalAgentClient(fakeAgent);

    // Consume the generator
    for await (const _ of client.chat('ch-1', 'conv-2', 'test message')) {
      // no events
    }

    expect(receivedArgs).toEqual(['ch-1', 'conv-2', 'test message']);
  });
});

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
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createClient(workspace?: string) {
    return new PooledAgentClient(
      'test-agent',
      { ...agentConfig },
      { anthropic: 'sk-test-key' },
      tmpDir,
      workspace ?? '/tmp/workspace',
    );
  }

  it('creates a new backend on first message (pool miss)', async () => {
    const client = createClient();
    const events: AgentEvent[] = [];

    for await (const event of client.chat('ch-1', 'conv-1', 'hi')) {
      events.push(event);
    }

    expect(MockedPiAgentBackend).toHaveBeenCalledOnce();
    expect(MockedPiAgentBackend).toHaveBeenCalledWith(
      expect.objectContaining({ model: agentConfig.model }),
      { anthropic: 'sk-test-key' },
      undefined, // logger
      join(tmpDir, 'conv-1'),
      undefined, // managedSkillsDir
    );
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
    expect(MockedPiAgentBackend).toHaveBeenCalledOnce();
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

    expect(MockedPiAgentBackend).toHaveBeenCalledTimes(2);
    expect(MockedDashAgent).toHaveBeenCalledTimes(2);

    // Verify different session directories
    const calls = vi.mocked(MockedPiAgentBackend).mock.calls;
    expect(calls[0][3]).toBe(join(tmpDir, 'conv-A'));
    expect(calls[1][3]).toBe(join(tmpDir, 'conv-B'));
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
    vi.clearAllMocks();
    for await (const _ of client.chat('ch-1', 'conv-1', 'hi again')) {
      // consume
    }
    expect(MockedPiAgentBackend).toHaveBeenCalledOnce();
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
    vi.clearAllMocks();
    for await (const _ of client.chat('ch-1', 'conv-new', 'hi')) {
      // consume
    }

    // The PiAgentBackend constructor should receive the updated config
    expect(MockedPiAgentBackend).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'anthropic/claude-haiku-3-20250714' }),
      expect.any(Object),
      undefined,
      join(tmpDir, 'conv-new'),
      undefined, // managedSkillsDir
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

  it('passes managedSkillsDir to PiAgentBackend when provided', async () => {
    const client = new PooledAgentClient(
      'test-agent',
      { ...agentConfig },
      { anthropic: 'sk-test-key' },
      tmpDir,
      '/tmp/workspace',
      undefined, // logger
      '/tmp/skills',
    );

    for await (const _ of client.chat('ch-1', 'conv-1', 'hi')) {
      // consume
    }

    expect(MockedPiAgentBackend).toHaveBeenCalledWith(
      expect.objectContaining({ model: agentConfig.model }),
      { anthropic: 'sk-test-key' },
      undefined,
      join(tmpDir, 'conv-1'),
      '/tmp/skills',
    );
  });

  it('uses process.cwd() when workspace is not provided', async () => {
    const client = new PooledAgentClient(
      'test-agent',
      { ...agentConfig },
      { anthropic: 'sk-test-key' },
      tmpDir,
    );

    for await (const _ of client.chat('ch-1', 'conv-1', 'hi')) {
      // consume
    }

    expect(mockStart).toHaveBeenCalledWith(process.cwd());
  });
});
