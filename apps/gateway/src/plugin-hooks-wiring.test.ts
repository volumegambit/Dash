import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentClient } from '@dash/agent';
import type { ChannelAdapter, InboundMessage } from '@dash/channels';
import { createHookEngine, loadPlugins } from '@dash/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDynamicGateway } from './gateway.js';

/**
 * Task-7 assembly assertion: a trusted plugin's `hooks.json` is loaded into
 * `loadedPlugins.hookConfigs`, `createHookEngine(...)` turns it into an engine
 * that reports `hasHooks`, and that single engine drives BOTH wiring points:
 *   1. the channel gateway's `messageHook` (UserPromptSubmit), and
 *   2. the backend's `HookRunner` interface shape (tool/session hooks).
 *
 * This is the cross-package wiring the gateway entrypoint performs; the
 * entrypoint itself is a `main()` and not directly importable, so we reproduce
 * the exact same assembly here against a real plugin on disk.
 */

async function writeHookPlugin(
  pluginsDir: string,
  name: string,
  // `eventMap` is the Claude Code event→groups map; real hooks.json nests it
  // under a top-level "hooks" key (see hooks-manifest validateHooksJson).
  eventMap: Record<string, unknown>,
): Promise<void> {
  const dir = join(pluginsDir, name);
  await mkdir(join(dir, '.claude-plugin'), { recursive: true });
  await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
  await mkdir(join(dir, 'hooks'), { recursive: true });
  await writeFile(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: eventMap }));
}

function makeFakeAgent(): AgentClient {
  return {
    chat: vi.fn().mockImplementation(async function* () {
      yield { type: 'response', content: 'ok' };
    }),
  } as unknown as AgentClient;
}

function makeFakeAdapter(name: string): ChannelAdapter & {
  trigger: (msg: InboundMessage) => Promise<void>;
} {
  let handler: ((msg: InboundMessage) => Promise<void>) | undefined;
  return {
    name,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    onMessage: (h) => {
      handler = h;
    },
    trigger: async (msg) => {
      await handler?.(msg);
    },
  };
}

describe('gateway plugin hook assembly (Task 7)', () => {
  let dataDir: string;
  let pluginsDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'gw-hooks-'));
    pluginsDir = join(dataDir, 'plugins');
    await mkdir(pluginsDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function buildEngine(hooks: Record<string, unknown>) {
    await writeHookPlugin(pluginsDir, 'hooky', hooks);
    const loaded = await loadPlugins({
      pluginsDir,
      entries: { hooky: { enabled: true, trusted: true } },
    });
    expect(loaded.hookConfigs.length).toBe(1);
    return createHookEngine(loaded.hookConfigs, { dataDir });
  }

  it('builds an engine with hasHooks from a trusted plugin hooks.json', async () => {
    const engine = await buildEngine({
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'true' }] }],
    });
    expect(engine.hasHooks).toBe(true);
  });

  it('engine drives the channel messageHook: UserPromptSubmit prepends additionalContext', async () => {
    // A hook that emits additionalContext on stdout (Claude Code envelope).
    const engine = await buildEngine({
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: 'printf \'{"hookSpecificOutput":{"additionalContext":"INJECTED"}}\'',
            },
          ],
        },
      ],
    });

    const gw = createDynamicGateway({
      messageHook: engine.hasHooks
        ? (i) =>
            engine.runUserPromptSubmit({
              prompt: i.prompt,
              sessionId: i.conversationId,
              cwd: dataDir,
            })
        : undefined,
    });
    const agent = makeFakeAgent();
    gw.registerAgent('agent1', agent);
    const adapter = makeFakeAdapter('tg1');
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: [],
      routing: [{ condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] }],
    });

    await adapter.trigger({
      channelId: 'tg1',
      conversationId: 'conv1',
      senderId: 'user1',
      senderName: 'User',
      text: 'hello',
      timestamp: new Date(),
    });

    expect(agent.chat).toHaveBeenCalledTimes(1);
    const promptArg = (agent.chat as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    expect(promptArg.startsWith('INJECTED')).toBe(true);
    expect(promptArg).toContain('hello');
  });

  it('engine satisfies the backend HookRunner shape (tool + lifecycle methods)', async () => {
    const engine = await buildEngine({
      PreToolUse: [
        {
          matcher: 'bash',
          hooks: [{ type: 'command', command: 'exit 2' }], // exit 2 → block
        },
      ],
    });

    // Backend-facing surface: methods exist and behave (PreToolUse blocks bash).
    expect(typeof engine.runPreToolUse).toBe('function');
    expect(typeof engine.runPostToolUse).toBe('function');
    expect(typeof engine.runSessionStart).toBe('function');
    expect(typeof engine.runStop).toBe('function');

    const pre = await engine.runPreToolUse({ toolName: 'bash', toolInput: {}, cwd: dataDir });
    expect(pre.block).toBe(true);

    // A non-matching tool is not blocked.
    const preOther = await engine.runPreToolUse({ toolName: 'read', toolInput: {}, cwd: dataDir });
    expect(preOther.block).toBe(false);
  });
});
