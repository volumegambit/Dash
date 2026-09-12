import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentClient } from '@dash/agent';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from '@dash/channels';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayAdmissionController } from './admission-controller.js';
import { createDynamicGateway } from './gateway.js';
import {
  FLUSH_TIMEOUT_MS,
  closeHttpServer,
  createGatewayShutdownCoordinator,
  describeError,
  redactBotTokens,
  safeFlush,
  safeStep,
  withTimeout,
} from './shutdown.js';

describe('redactBotTokens', () => {
  it('redacts a Telegram bot token embedded in a URL', () => {
    const msg =
      'request to https://api.telegram.org/bot7212121212:AAE-abcDEF_ghi123JKLmno456pqr789stU/getUpdates failed, reason: connect ETIMEDOUT';
    const redacted = redactBotTokens(msg);
    expect(redacted).not.toContain('AAE-abcDEF_ghi123JKLmno456pqr789stU');
    expect(redacted).toContain('bot7212121212:<redacted>');
    expect(redacted).toContain('/getUpdates');
  });

  it('leaves text without tokens unchanged', () => {
    const msg = 'Network request for getUpdates failed';
    expect(redactBotTokens(msg)).toBe(msg);
  });
});

describe('describeError', () => {
  it('uses the stack when available and redacts tokens in it', () => {
    const err = new Error(
      'request to https://api.telegram.org/bot123456:secretTOKENvalue-here_0/getUpdates failed',
    );
    const out = describeError(err);
    expect(out).not.toContain('secretTOKENvalue-here_0');
    expect(out).toContain('bot123456:<redacted>');
  });

  it('stringifies non-Error values', () => {
    expect(describeError('boom')).toBe('boom');
  });
});

describe('safeStep', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the step and resolves on success', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    await safeStep('gateway.stop', fn);
    expect(fn).toHaveBeenCalled();
  });

  it('resolves and logs when an async step rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      safeStep('gateway.stop', () => Promise.reject(new Error('network down'))),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('gateway.stop'),
      expect.stringContaining('network down'),
    );
  });

  it('resolves and logs when a sync step throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      safeStep('db.close', () => {
        throw new Error('already closed');
      }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('redacts bot tokens from the logged failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await safeStep('gateway.stop', () =>
      Promise.reject(
        new Error(
          'request to https://api.telegram.org/bot99:SsEeCcRrEeTt-token_9/getUpdates failed',
        ),
      ),
    );
    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('SsEeCcRrEeTt-token_9');
    expect(logged).toContain('bot99:<redacted>');
  });
});

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'fast op')).resolves.toBe('ok');
  });

  it('rejects with the original error when the promise rejects in time', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'op')).rejects.toThrow(
      'boom',
    );
  });

  it('rejects with a labeled timeout error when the promise hangs', async () => {
    vi.useFakeTimers();
    try {
      const hang = new Promise(() => {});
      const raced = withTimeout(hang, 5000, 'adapter stop for channel "tg1"');
      const assertion = expect(raced).rejects.toThrow(
        'adapter stop for channel "tg1" timed out after 5000ms',
      );
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('safeFlush', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('awaits a flush that completes in time', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    await safeFlush('memorySweep.flush', flush, 1000);
    expect(flush).toHaveBeenCalled();
  });

  it('gives up on a hung flush instead of blocking shutdown forever', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const step = safeFlush('memorySweep.flush', () => new Promise<void>(() => {}), 5000);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(step).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('memorySweep.flush'),
      expect.stringContaining('timed out after 5000ms'),
    );
  });

  it('logs and continues when the flush rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      safeFlush('conversationAutoTitle.flush', () => Promise.reject(new Error('boom')), 1000),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('defaults to a bounded deadline', () => {
    expect(FLUSH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(FLUSH_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe('gateway shutdown coordination', () => {
  it('reports exact lifecycle-ingress ownership when a concurrent shutdown joins', async () => {
    const admission = new GatewayAdmissionController();
    const ownerIngress = admission.acquireLifecycleIngress();
    const duplicateIngress = admission.acquireLifecycleIngress();
    const coordinator = createGatewayShutdownCoordinator({
      admission,
      resumableChatHub: { suspend: vi.fn() },
      getChatLifecycles: () => [],
      getProjectsLifecycle: () => undefined,
      mcpManager: { stop: vi.fn() },
      swarmCoordinator: { stop: vi.fn() },
      agents: { interruptAll: vi.fn(), stop: vi.fn() },
      gateway: { stop: vi.fn() },
      getManagementServer: () => undefined,
      getLanServer: () => undefined,
      conversationService: { close: vi.fn() },
      projectsDb: { close: vi.fn() },
    });

    const first = coordinator.shutdown(ownerIngress);
    const duplicate = coordinator.shutdown(duplicateIngress);
    try {
      expect(first.ownerLeaseTransferred).toBe(true);
      expect(duplicate.ownerLeaseTransferred).toBe(false);
      expect(duplicate.completion).toBe(first.completion);

      let settled = false;
      void first.completion.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      duplicateIngress.release();
      await first.completion;
      expect(settled).toBe(true);
    } finally {
      duplicateIngress.release();
      const legacyCompletion = first instanceof Promise ? first : first.completion;
      await Promise.allSettled([legacyCompletion]);
    }
  });

  it('fences direct, LAN, and projects upgrades synchronously before a held suspension', async () => {
    const admission = new GatewayAdmissionController();
    const allowSuspension = Promise.withResolvers<void>();
    const direct = {
      beginClosing: vi.fn(),
      flushAndCloseAll: vi.fn(),
    };
    const lan = {
      beginClosing: vi.fn(),
      flushAndCloseAll: vi.fn(),
    };
    const projects = {
      beginClosing: vi.fn(),
      flushAndCloseAll: vi.fn(),
    };
    const coordinator = createGatewayShutdownCoordinator({
      admission,
      resumableChatHub: { suspend: vi.fn(() => allowSuspension.promise) },
      getChatLifecycles: () => [direct, lan],
      getProjectsLifecycle: () => projects,
      mcpManager: { stop: vi.fn() },
      swarmCoordinator: { stop: vi.fn() },
      agents: { interruptAll: vi.fn(), stop: vi.fn() },
      gateway: { stop: vi.fn() },
      getManagementServer: () => undefined,
      getLanServer: () => undefined,
      conversationService: { close: vi.fn() },
      projectsDb: { close: vi.fn() },
    });

    const shutdown = coordinator.shutdown().completion;
    try {
      expect(direct.beginClosing).toHaveBeenCalledWith(1012, 'gateway_shutdown');
      expect(lan.beginClosing).toHaveBeenCalledWith(1012, 'gateway_shutdown');
      expect(projects.beginClosing).toHaveBeenCalledWith(1012, 'gateway_shutdown');
      expect(direct.flushAndCloseAll).not.toHaveBeenCalled();
      expect(lan.flushAndCloseAll).not.toHaveBeenCalled();
      expect(projects.flushAndCloseAll).not.toHaveBeenCalled();
    } finally {
      allowSuspension.resolve();
      await shutdown;
    }
  });

  it('interrupts a pre-ready backend before awaiting hub suspension', async () => {
    const admission = new GatewayAdmissionController();
    const readinessHeld = Promise.withResolvers<void>();
    const calls: string[] = [];
    const coordinator = createGatewayShutdownCoordinator({
      admission,
      resumableChatHub: {
        suspend: vi.fn(async () => {
          calls.push('hub.suspend');
          await readinessHeld.promise;
        }),
      },
      getChatLifecycles: () => [],
      getProjectsLifecycle: () => undefined,
      mcpManager: { stop: vi.fn() },
      swarmCoordinator: { stop: vi.fn() },
      agents: {
        interruptAll: vi.fn(() => {
          calls.push('agents.interruptAll');
          readinessHeld.resolve();
        }),
        stop: vi.fn(),
      },
      gateway: { stop: vi.fn() },
      getManagementServer: () => undefined,
      getLanServer: () => undefined,
      conversationService: { close: vi.fn() },
      projectsDb: { close: vi.fn() },
    });

    const shutdown = coordinator.shutdown().completion;
    try {
      await vi.waitFor(() => expect(calls).toContain('agents.interruptAll'));
      await shutdown;
    } finally {
      readinessHeld.resolve();
      await Promise.allSettled([shutdown]);
    }

    expect(calls.indexOf('agents.interruptAll')).toBeLessThan(calls.indexOf('hub.suspend'));
  });

  it('handles an immediate listener-close rejection while an earlier shutdown step is held', async () => {
    const admission = new GatewayAdmissionController();
    let releaseSuspend!: () => void;
    const heldSuspend = new Promise<void>((resolve) => {
      releaseSuspend = resolve;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => {
        callback(new Error('listener close failed immediately'));
        return server;
      }),
    };
    const coordinator = createGatewayShutdownCoordinator({
      admission,
      resumableChatHub: { suspend: vi.fn(() => heldSuspend) },
      getChatLifecycles: () => [],
      getProjectsLifecycle: () => undefined,
      mcpManager: { stop: vi.fn() },
      swarmCoordinator: { stop: vi.fn() },
      agents: { interruptAll: vi.fn(), stop: vi.fn() },
      gateway: { stop: vi.fn() },
      getManagementServer: () => server,
      getLanServer: () => undefined,
      conversationService: { close: vi.fn() },
      projectsDb: { close: vi.fn() },
    });

    try {
      const shutdown = coordinator.shutdown().completion;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);

      releaseSuspend();
      await shutdown;
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('managementServer.close'),
        expect.stringContaining('listener close failed immediately'),
      );
    } finally {
      releaseSuspend();
      process.off('unhandledRejection', onUnhandled);
      errorSpy.mockRestore();
    }
  });

  it('starts stream abort, then drains pre-fence mutations before other runtime resources', async () => {
    const calls: string[] = [];
    const admission = new GatewayAdmissionController();
    const mutation = admission.acquire();
    const coordinator = createGatewayShutdownCoordinator({
      admission,
      resumableChatHub: {
        suspend: vi.fn(async () => {
          calls.push('hub.suspend');
        }),
      },
      getChatLifecycles: () => [],
      getProjectsLifecycle: () => undefined,
      mcpManager: { stop: vi.fn(async () => calls.push('mcp.stop')) },
      swarmCoordinator: { stop: vi.fn(async () => calls.push('swarm.stop')) },
      agents: {
        interruptAll: vi.fn(() => calls.push('agents.interruptAll')),
        stop: vi.fn(async () => calls.push('agents.stop')),
      },
      gateway: { stop: vi.fn(async () => calls.push('gateway.stop')) },
      getManagementServer: () => undefined,
      getLanServer: () => undefined,
      conversationService: { close: vi.fn(() => calls.push('conversations.close')) },
      projectsDb: { close: vi.fn(() => calls.push('projects.close')) },
    });

    const shutdown = coordinator.shutdown().completion;
    await vi.waitFor(() => expect(calls).toContain('hub.suspend'));
    await Promise.resolve();
    expect(calls).not.toContain('mcp.stop');
    expect(calls).not.toContain('swarm.stop');
    expect(calls).toContain('agents.interruptAll');
    expect(calls).not.toContain('agents.stop');
    expect(calls).not.toContain('gateway.stop');

    mutation.release();
    await shutdown;
    expect(calls.indexOf('agents.interruptAll')).toBeLessThan(calls.indexOf('mcp.stop'));
    expect(calls.indexOf('agents.interruptAll')).toBeLessThan(calls.indexOf('hub.suspend'));
    expect(calls.indexOf('hub.suspend')).toBeLessThan(calls.indexOf('mcp.stop'));
    expect(calls.indexOf('mcp.stop')).toBeLessThan(calls.indexOf('gateway.stop'));
  });

  it('stops pool-backed channel streams before waiting for their production ingress lease', async () => {
    const admission = new GatewayAdmissionController();
    const gateway = createDynamicGateway({ admission });
    let releaseStream!: () => void;
    const streamRelease = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let markStreamStarted!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      markStreamStarted = resolve;
    });
    const agent = {
      chat: vi.fn().mockImplementation(async function* () {
        markStreamStarted();
        await streamRelease;
        yield* [];
      }),
    } as unknown as AgentClient;
    let messageHandler: ((message: InboundMessage) => Promise<void>) | undefined;
    const adapter: ChannelAdapter & { trigger(message: InboundMessage): Promise<void> } = {
      name: 'held-channel',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      onMessage(handler) {
        messageHandler = handler;
      },
      getHealth: () => 'connected',
      onHealthChange: () => {},
      async trigger(message) {
        await messageHandler?.(message);
      },
    };
    gateway.registerAgent('agent-stream', agent);
    await gateway.registerChannel('held-channel', adapter, {
      globalDenyList: [],
      routing: [
        {
          condition: { type: 'default' },
          agentId: 'agent-stream',
          allowList: [],
          denyList: [],
        },
      ],
    });
    const agents = {
      interruptAll: vi.fn(() => {
        releaseStream();
      }),
      stop: vi.fn(),
    };
    const coordinator = createGatewayShutdownCoordinator({
      admission,
      resumableChatHub: { suspend: vi.fn().mockResolvedValue(undefined) },
      getChatLifecycles: () => [],
      getProjectsLifecycle: () => undefined,
      mcpManager: { stop: vi.fn() },
      swarmCoordinator: { stop: vi.fn() },
      agents,
      gateway,
      getManagementServer: () => undefined,
      getLanServer: () => undefined,
      conversationService: { close: vi.fn() },
      projectsDb: { close: vi.fn() },
    });
    const channelMessage = adapter.trigger({
      channelId: 'held-channel',
      conversationId: 'conversation-1',
      senderId: 'user-1',
      senderName: 'User',
      text: 'hold this channel stream',
      timestamp: new Date('2026-09-07T00:00:00.000Z'),
    });
    await streamStarted;
    const shutdown = coordinator.shutdown().completion;

    try {
      await vi.waitFor(() => expect(agents.interruptAll).toHaveBeenCalledOnce());
      await channelMessage;
      await shutdown;
      expect(agents.stop).toHaveBeenCalledOnce();
      expect(adapter.stop).toHaveBeenCalledOnce();
    } finally {
      releaseStream();
      await Promise.allSettled([channelMessage, shutdown, gateway.stop()]);
    }
  });

  it('aborts a held channel reply before draining its ingress lease and later stops the adapter', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const admission = new GatewayAdmissionController();
    const gateway = createDynamicGateway({ admission });
    const sendStarted = Promise.withResolvers<void>();
    const releaseSend = Promise.withResolvers<void>();
    const calls: string[] = [];
    let sendSignal: AbortSignal | undefined;
    let messageHandler: ((message: InboundMessage) => Promise<void>) | undefined;
    const adapter: ChannelAdapter & { trigger(message: InboundMessage): Promise<void> } = {
      name: 'held-send',
      start: vi.fn(),
      stop: vi.fn(async () => {
        calls.push('adapter.stop');
      }),
      send: vi.fn(
        async (_conversationId: string, _message: OutboundMessage, signal?: AbortSignal) => {
          sendSignal = signal;
          calls.push('adapter.send');
          sendStarted.resolve();
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              calls.push('send.abort');
              reject(new Error('send aborted'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            void releaseSend.promise.then(resolve);
          });
        },
      ),
      onMessage: vi.fn((handler) => {
        messageHandler = handler;
      }),
      getHealth: vi.fn(() => 'connected' as const),
      onHealthChange: vi.fn(),
      async trigger(message) {
        await messageHandler?.(message);
      },
    };
    gateway.registerAgent('agent-1', {
      chat: vi.fn(),
      listSkills: vi.fn(),
    } as unknown as AgentClient);
    await gateway.registerChannel('held-send', adapter, {
      globalDenyList: [],
      routing: [
        {
          condition: { type: 'default' },
          agentId: 'agent-1',
          allowList: [],
          denyList: [],
        },
      ],
    });
    const inbound = adapter.trigger({
      channelId: 'held-send',
      conversationId: 'conversation-1',
      senderId: 'user-1',
      senderName: 'User',
      text: '/help',
      timestamp: new Date('2026-09-07T00:00:00.000Z'),
    });
    await sendStarted.promise;

    const coordinator = createGatewayShutdownCoordinator({
      admission,
      resumableChatHub: { suspend: vi.fn() },
      getChatLifecycles: () => [],
      getProjectsLifecycle: () => undefined,
      mcpManager: { stop: vi.fn() },
      swarmCoordinator: { stop: vi.fn() },
      agents: { interruptAll: vi.fn(), stop: vi.fn() },
      gateway,
      getManagementServer: () => undefined,
      getLanServer: () => undefined,
      conversationService: { close: vi.fn() },
      projectsDb: { close: vi.fn() },
    });
    const shutdown = coordinator.shutdown().completion;

    try {
      await vi.waitFor(() => expect(sendSignal?.aborted).toBe(true));
      await inbound;
      await shutdown;
      expect(calls.indexOf('send.abort')).toBeLessThan(calls.indexOf('adapter.stop'));
      expect(adapter.stop).toHaveBeenCalledOnce();
    } finally {
      releaseSend.resolve();
      await Promise.allSettled([inbound, shutdown, gateway.stop()]);
      errorSpy.mockRestore();
    }
  });

  it('fences synchronously, suspends before teardown, and closes storage last', async () => {
    const calls: string[] = [];
    const admission = new GatewayAdmissionController();
    const beginProcessShutdown = vi.spyOn(admission, 'beginProcessShutdown');
    let finishManagementClose!: () => void;
    let finishLanClose!: () => void;
    const managementServer = {
      close: vi.fn((callback: () => void) => {
        calls.push('management.close');
        finishManagementClose = callback;
        return managementServer;
      }),
      closeAllConnections: vi.fn(() => calls.push('management.closeAllConnections')),
    };
    const lanServer = {
      close: vi.fn((callback: () => void) => {
        calls.push('lan.close');
        finishLanClose = callback;
        return lanServer;
      }),
      closeAllConnections: vi.fn(() => calls.push('lan.closeAllConnections')),
    };
    const cleanupTokenSeen: unknown[] = [];
    const coordinator = createGatewayShutdownCoordinator({
      admission,
      relayClient: { stop: vi.fn(async () => calls.push('relay.stop')) },
      resumableChatHub: {
        suspend: vi.fn(async (cleanupToken) => {
          cleanupTokenSeen.push(cleanupToken);
          calls.push('hub.suspend');
        }),
      },
      getChatLifecycles: () => [
        {
          beginClosing: vi.fn(() => calls.push('chat.beginClosing')),
          flushAndCloseAll: vi.fn(async (code, reason) => {
            expect([code, reason]).toEqual([1012, 'gateway_shutdown']);
            calls.push('chat.flushAndCloseAll');
          }),
        },
      ],
      getProjectsLifecycle: () => ({
        beginClosing: vi.fn(() => calls.push('projects.beginClosing')),
        flushAndCloseAll: vi.fn(async (code, reason) => {
          expect([code, reason]).toEqual([1012, 'gateway_shutdown']);
          calls.push('projects.flushAndCloseAll');
        }),
      }),
      mcpManager: { stop: vi.fn(async () => calls.push('mcp.stop')) },
      swarmCoordinator: { stop: vi.fn(async () => calls.push('swarm.stop')) },
      agents: {
        interruptAll: vi.fn(() => calls.push('agents.interruptAll')),
        stop: vi.fn(async () => calls.push('agents.stop')),
      },
      gateway: { stop: vi.fn(async () => calls.push('gateway.stop')) },
      backgroundFlushes: [
        {
          label: 'learning',
          flush: vi.fn(async () => {
            calls.push('learning.flush');
          }),
        },
      ],
      getManagementServer: () => managementServer,
      getLanServer: () => lanServer,
      conversationService: { close: vi.fn(() => calls.push('conversations.close')) },
      projectsDb: { close: vi.fn(() => calls.push('projectsDb.close')) },
      timeoutMs: 1_000,
    });

    const shutdown = coordinator.shutdown().completion;

    expect(beginProcessShutdown).toHaveBeenCalledOnce();
    expect(admission.isOpen('agent-after-fence')).toBe(false);
    expect(managementServer.close).toHaveBeenCalledOnce();
    expect(lanServer.close).toHaveBeenCalledOnce();
    expect(calls.slice(0, 4)).toEqual([
      'chat.beginClosing',
      'projects.beginClosing',
      'management.close',
      'lan.close',
    ]);
    expect(calls).not.toContain('conversations.close');

    await vi.waitFor(() => expect(calls).toContain('gateway.stop'));
    expect(calls.indexOf('relay.stop')).toBeLessThan(calls.indexOf('hub.suspend'));
    expect(calls.indexOf('hub.suspend')).toBeLessThan(calls.indexOf('mcp.stop'));
    expect(calls.indexOf('hub.suspend')).toBeLessThan(calls.indexOf('swarm.stop'));
    expect(calls.indexOf('hub.suspend')).toBeLessThan(calls.indexOf('agents.stop'));
    expect(calls.indexOf('mcp.stop')).toBeLessThan(calls.indexOf('learning.flush'));
    expect(calls.indexOf('learning.flush')).toBeLessThan(calls.indexOf('gateway.stop'));
    expect(cleanupTokenSeen).toHaveLength(1);
    expect(calls).not.toContain('conversations.close');

    finishManagementClose();
    finishLanClose();
    await shutdown;

    expect(calls.at(-2)).toBe('projectsDb.close');
    expect(calls.at(-1)).toBe('conversations.close');
  });

  it('starts Server.close synchronously and uses the bounded connection fallback', async () => {
    vi.useFakeTimers();
    try {
      let finishClose!: () => void;
      const server = {
        close: vi.fn((callback: () => void) => {
          finishClose = callback;
          return server;
        }),
        closeAllConnections: vi.fn(() => finishClose()),
      };

      const closing = closeHttpServer(server, 250);
      expect(server.close).toHaveBeenCalledOnce();
      expect(server.closeAllConnections).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(249);
      expect(server.closeAllConnections).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(server.closeAllConnections).toHaveBeenCalledOnce();
      await expect(closing).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['/events', '/mobile/v1/events', '/mobile/v2/events'])(
    'bounds shutdown while an authenticated SSE stream is held on %s',
    async (path) => {
      const server = createServer((request, response) => {
        if (request.url !== path || request.headers.authorization !== 'Bearer test-token') {
          response.writeHead(401).end();
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          Connection: 'keep-alive',
        });
        response.write(': ready\n\n');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          headers: { Authorization: 'Bearer test-token' },
        });
        reader = response.body?.getReader();
        if (!reader) throw new Error('SSE response has no body');
        expect((await reader.read()).done).toBe(false);

        const readerClosed = reader.closed.catch(() => undefined);
        await expect(closeHttpServer(server, 25)).resolves.toBeUndefined();
        await expect(readerClosed).resolves.toBeUndefined();
      } finally {
        await reader?.cancel().catch(() => undefined);
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
