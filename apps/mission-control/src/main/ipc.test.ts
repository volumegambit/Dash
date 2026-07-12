import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We need to import makePackagedSpawner — it doesn't exist yet, so this will fail
// Import it from ipc.ts after you implement it
import { InMemoryKeychainStore } from '@dash/mc';
import { verifyConversationGateway } from './gateway-connection.js';
import {
  ConversationLifecycleEpoch,
  GatewayEventStreamManager,
  activatePendingConversationRuntime,
  configurePendingConversationRuntime,
  conversationContextFromOfflineProfile,
  createCanonicalChatHandlers,
  createGatewaySubscriptionLifecycle,
  createLegacyWireChatAdapter,
  disposePendingConversationRuntime,
  enrollGateway,
  isSetupConfigured,
  makePackagedSpawner,
  parseConversationInvalidations,
  pluginInstallHandler,
  pluginReloadHandler,
  pluginRemoveHandler,
  pluginRuntimeHandler,
  pluginSetStateHandler,
  pluginsListHandler,
  projectsAssignAgentHandler,
  resolveSetupStatus,
  shutdownGatewayOnQuit,
  verifiedConversationContext,
} from './ipc.js';

const mobileFixtures = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../contracts/mobile/v1/fixtures',
);

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(mobileFixtures, name), 'utf8')) as T;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('conversation sync lifecycle selection', () => {
  it('verifies capabilities and authenticated identity before selecting gateway authority', async () => {
    const health = await fixture<{
      status: 'healthy';
      startedAt: string;
      agents: number;
      channels: number;
      apiVersion: number;
      capabilities: ['conversation-sync-v1', 'chat-resume-v1'];
    }>('health-capabilities.json');
    const identity = await fixture<{ gatewayId: string; publicKey: string }>('identity.json');
    const client = {
      health: vi.fn().mockResolvedValue(health),
      getIdentity: vi.fn().mockResolvedValue(identity),
    };

    await expect(verifiedConversationContext(client)).resolves.toEqual({
      gatewayId: identity.gatewayId,
      apiVersion: health.apiVersion,
      capabilities: health.capabilities,
    });
    expect(client.health.mock.invocationCallOrder[0]).toBeLessThan(
      client.getIdentity.mock.invocationCallOrder[0],
    );
  });

  it('activates and detaches the pending resumable transport atomically', () => {
    const setResumableTransport = vi.fn();
    const transport = { closeAll: vi.fn() };

    activatePendingConversationRuntime(
      { setResumableTransport } as never,
      {
        gatewayId: 'gateway-1',
        repository: { offline: false },
        transport,
      } as never,
    );
    activatePendingConversationRuntime({ setResumableTransport } as never, null);

    expect(setResumableTransport).toHaveBeenNthCalledWith(1, transport);
    expect(setResumableTransport).toHaveBeenNthCalledWith(2, undefined);
  });

  it('forwards canonical refs, cursors, revisions, and turn IDs through handler bodies', async () => {
    const ref = { id: 'conversation-1', origin: 'gateway' as const };
    const chat = {
      listConversations: vi.fn(),
      createConversation: vi.fn(),
      getMessages: vi.fn(),
      sendMessage: vi.fn(),
      renameConversation: vi.fn(),
      deleteConversation: vi.fn(),
      cancel: vi.fn(),
      answerQuestion: vi.fn(),
    };
    const controller = { find: vi.fn() };
    const handlers = createCanonicalChatHandlers(chat as never, controller as never);
    const images = [{ mediaType: 'image/png' as const, data: 'aGVsbG8=' }];

    await handlers.listConversations('cursor-1');
    await handlers.getConversation(ref);
    await handlers.createConversation('agent-1', 'request-1');
    await handlers.getMessages(ref, 'before-1');
    await handlers.sendMessage(ref, 'turn-1', 'hello', images);
    await handlers.renameConversation(ref, 4, 'Renamed');
    await handlers.deleteConversation(ref, 5);
    handlers.cancel(ref, 'turn-1');
    handlers.answerQuestion(ref, 'turn-1', 'question-1', 'Yes');

    expect(chat.listConversations).toHaveBeenCalledWith('cursor-1');
    expect(controller.find).toHaveBeenCalledWith(ref);
    expect(chat.createConversation).toHaveBeenCalledWith('agent-1', 'request-1');
    expect(chat.getMessages).toHaveBeenCalledWith(ref, 'before-1');
    expect(chat.sendMessage).toHaveBeenCalledWith(ref, 'turn-1', 'hello', images);
    expect(chat.renameConversation).toHaveBeenCalledWith(ref, 4, 'Renamed');
    expect(chat.deleteConversation).toHaveBeenCalledWith(ref, 5);
    expect(chat.cancel).toHaveBeenCalledWith(ref, 'turn-1');
    expect(chat.answerQuestion).toHaveBeenCalledWith(ref, 'turn-1', 'question-1', 'Yes');
  });

  it('selects explicit legacy authority without requiring an identity route', async () => {
    const client = {
      health: vi.fn().mockResolvedValue({
        status: 'healthy',
        startedAt: '2026-07-12T00:00:00Z',
        agents: 1,
        channels: 0,
        apiVersion: 0,
        capabilities: [],
      }),
      getIdentity: vi.fn(),
    };

    await expect(verifiedConversationContext(client)).resolves.toEqual({
      gatewayId: null,
      apiVersion: 0,
      capabilities: [],
    });
    expect(client.getIdentity).not.toHaveBeenCalled();
  });

  it('restores a persisted capable identity as offline instead of selecting legacy writes', () => {
    expect(
      conversationContextFromOfflineProfile({
        mode: 'relay',
        gatewayId: 'gateway-1',
        apiVersion: 1,
        capabilities: ['conversation-sync-v1', 'chat-resume-v1'],
      }),
    ).toEqual({
      gatewayId: 'gateway-1',
      online: false,
      capabilities: ['conversation-sync-v1', 'chat-resume-v1'],
    });
  });

  it('constructs and configures a pending capable runtime without activating ChatService', () => {
    const repository = { offline: false };
    const transport = { closeAll: vi.fn() };
    const controller = { configure: vi.fn() };
    const activeChatService = { setResumableTransport: vi.fn() };
    const createRepository = vi.fn(() => repository);
    const createTransport = vi.fn(() => transport);

    const pending = configurePendingConversationRuntime({
      controller: controller as never,
      context: {
        gatewayId: 'gateway-1',
        online: true,
        capabilities: ['conversation-sync-v1', 'chat-resume-v1'],
      },
      existing: null,
      createRepository: createRepository as never,
      createTransport: createTransport as never,
    });

    expect(pending).toMatchObject({ gatewayId: 'gateway-1', repository, transport });
    expect(controller.configure).toHaveBeenCalledWith({
      gatewayId: 'gateway-1',
      online: true,
      capabilities: ['conversation-sync-v1', 'chat-resume-v1'],
      repository,
    });
    expect(activeChatService.setResumableTransport).not.toHaveBeenCalled();
  });

  it('restores a known capable pending repository read-only while offline', () => {
    const repository = { offline: false };
    const transport = { closeAll: vi.fn() };
    const controller = { configure: vi.fn() };
    const existing = { gatewayId: 'gateway-1', repository, transport };

    const pending = configurePendingConversationRuntime({
      controller: controller as never,
      context: {
        gatewayId: 'gateway-1',
        online: false,
        capabilities: ['conversation-sync-v1'],
      },
      existing: existing as never,
      createRepository: vi.fn() as never,
      createTransport: vi.fn() as never,
    });

    expect(transport.closeAll).toHaveBeenCalledOnce();
    expect(pending).toEqual({ gatewayId: 'gateway-1', repository, transport: null });
    expect(controller.configure).toHaveBeenCalledWith({
      gatewayId: 'gateway-1',
      online: false,
      capabilities: ['conversation-sync-v1'],
      repository,
    });
  });

  it('replaces a different gateway runtime and detaches its transport once', () => {
    const previousTransport = { closeAll: vi.fn() };
    const nextRepository = { offline: false };

    const pending = configurePendingConversationRuntime({
      controller: { configure: vi.fn() } as never,
      context: {
        gatewayId: 'gateway-2',
        online: true,
        capabilities: ['conversation-sync-v1', 'chat-resume-v1'],
      },
      existing: {
        gatewayId: 'gateway-1',
        repository: { offline: false },
        transport: previousTransport,
      } as never,
      createRepository: vi.fn(() => nextRepository) as never,
      createTransport: vi.fn(() => ({ closeAll: vi.fn() })) as never,
    });

    expect(previousTransport.closeAll).toHaveBeenCalledOnce();
    expect(pending?.repository).toBe(nextRepository);
  });

  it('rebinds an online repository when credentials rotate for the same gateway', () => {
    const previousRepository = { offline: false, client: 'old' };
    const nextRepository = { offline: false, client: 'new' };
    const previousTransport = { closeAll: vi.fn() };
    const createRepository = vi.fn(() => nextRepository);

    const pending = configurePendingConversationRuntime({
      controller: { configure: vi.fn() } as never,
      context: {
        gatewayId: 'gateway-1',
        online: true,
        capabilities: ['conversation-sync-v1', 'chat-resume-v1'],
      },
      existing: {
        gatewayId: 'gateway-1',
        repository: previousRepository,
        transport: previousTransport,
      } as never,
      createRepository: createRepository as never,
      createTransport: vi.fn(() => ({ closeAll: vi.fn() })) as never,
    });

    expect(createRepository).toHaveBeenCalledOnce();
    expect(pending?.repository).toBe(nextRepository);
    expect(previousTransport.closeAll).toHaveBeenCalledOnce();
  });

  it('selects explicit legacy authority without touching the active ChatService transport', () => {
    const controller = { configure: vi.fn() };
    const activeChatTransport = { closeAll: vi.fn() };

    const pending = configurePendingConversationRuntime({
      controller: controller as never,
      context: { gatewayId: null, online: true, capabilities: [] },
      existing: null,
      createRepository: vi.fn() as never,
      createTransport: vi.fn() as never,
    });

    expect(pending).toBeNull();
    expect(controller.configure).toHaveBeenCalledWith({
      gatewayId: null,
      online: true,
      capabilities: [],
      repository: null,
    });
    expect(activeChatTransport.closeAll).not.toHaveBeenCalled();
  });

  it('maps frozen SSE invalidations to origin-aware conversation cache actions', async () => {
    const changed = await readFile(resolve(mobileFixtures, 'sse-conversation-changed.txt'), 'utf8');
    const deleted = await readFile(resolve(mobileFixtures, 'sse-conversation-deleted.txt'), 'utf8');

    expect(parseConversationInvalidations(`${changed}\n${deleted}`)).toEqual([
      expect.objectContaining({
        type: 'changed',
        conversation: { id: expect.any(String), origin: 'gateway' },
      }),
      expect.objectContaining({
        type: 'deleted',
        conversation: { id: expect.any(String), origin: 'gateway' },
      }),
    ]);
  });
});

describe('gateway event stream lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('invalidates an obsolete conversation lifecycle transition', () => {
    const lifecycle = new ConversationLifecycleEpoch();
    const first = lifecycle.begin();
    expect(first()).toBe(true);

    const second = lifecycle.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);

    lifecycle.invalidate();
    expect(second()).toBe(false);
  });

  it.each([
    ['a non-OK response', { ok: false, body: null }],
    [
      'end-of-stream',
      {
        ok: true,
        body: { getReader: () => ({ read: vi.fn().mockResolvedValue({ done: true }) }) },
      },
    ],
  ])('retries after %s while the gateway remains selected', async (_label, response) => {
    vi.useFakeTimers();
    const fetchStream = vi.fn().mockResolvedValue(response);
    const manager = new GatewayEventStreamManager({
      getEndpoint: vi.fn().mockResolvedValue({
        managementBaseUrl: 'https://gateway.example.com',
        managementToken: 'token',
        headers: {},
      }),
      fetchStream: fetchStream as never,
      retryMs: 1000,
      onEvent: vi.fn(),
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStream).toHaveBeenCalledTimes(1);
    expect(fetchStream).toHaveBeenCalledWith(
      'https://gateway.example.com/mobile/v1/events',
      expect.anything(),
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchStream).toHaveBeenCalledTimes(2);
    manager.stop();
  });

  it('retries when the active endpoint cannot be resolved', async () => {
    vi.useFakeTimers();
    const getEndpoint = vi.fn().mockRejectedValue(new Error('credentials unavailable'));
    const manager = new GatewayEventStreamManager({
      getEndpoint,
      fetchStream: vi.fn() as never,
      retryMs: 1000,
      onEvent: vi.fn(),
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(getEndpoint).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(getEndpoint).toHaveBeenCalledTimes(2);
    manager.stop();
  });

  it('drops late events from an obsolete gateway stream after restart', async () => {
    const firstRead = deferred<{ done: boolean; value?: Uint8Array }>();
    const secondRead = deferred<{ done: boolean; value?: Uint8Array }>();
    const firstReader = { read: vi.fn(() => firstRead.promise) };
    const secondReader = { read: vi.fn(() => secondRead.promise) };
    const fetchStream = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, body: { getReader: () => firstReader } })
      .mockResolvedValueOnce({ ok: true, body: { getReader: () => secondReader } });
    const onEvent = vi.fn();
    const manager = new GatewayEventStreamManager({
      getEndpoint: vi.fn().mockResolvedValue({
        managementBaseUrl: 'https://gateway.example.com',
        managementToken: 'token',
        headers: {},
      }),
      fetchStream: fetchStream as never,
      retryMs: 1000,
      onEvent,
    });

    manager.start();
    await vi.waitFor(() => expect(firstReader.read).toHaveBeenCalledOnce());
    manager.restart();
    await vi.waitFor(() => expect(secondReader.read).toHaveBeenCalledOnce());

    firstRead.resolve({
      done: false,
      value: new TextEncoder().encode(
        'event: conversation:deleted\ndata: {"conversationId":"old-id"}\n',
      ),
    });
    await Promise.resolve();

    expect(onEvent).not.toHaveBeenCalled();
    manager.stop();
    secondRead.resolve({ done: true });
  });

  it('aborts the active stream and suppresses retry after stop', async () => {
    vi.useFakeTimers();
    const pendingRead = deferred<{ done: boolean; value?: Uint8Array }>();
    const fetchStream = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read: vi.fn(() => pendingRead.promise) }) },
    });
    const manager = new GatewayEventStreamManager({
      getEndpoint: vi.fn().mockResolvedValue({
        managementBaseUrl: 'https://gateway.example.com',
        managementToken: 'token',
        headers: {},
      }),
      fetchStream: fetchStream as never,
      retryMs: 1000,
      onEvent: vi.fn(),
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    const signal = (fetchStream.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    manager.stop();
    expect(signal.aborted).toBe(true);

    pendingRead.resolve({ done: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchStream).toHaveBeenCalledTimes(1);
  });

  it('restarts and stops both gateway-owned subscriptions together', () => {
    const controls = {
      startEvents: vi.fn(),
      stopEvents: vi.fn(),
      connectProjects: vi.fn(),
      disconnectProjects: vi.fn(),
    };
    const lifecycle = createGatewaySubscriptionLifecycle(controls);

    lifecycle.restart();
    expect(controls.stopEvents).toHaveBeenCalledBefore(controls.startEvents);
    expect(controls.disconnectProjects).toHaveBeenCalledBefore(controls.connectProjects);

    lifecycle.stop();
    expect(controls.stopEvents).toHaveBeenCalledTimes(2);
    expect(controls.disconnectProjects).toHaveBeenCalledTimes(2);
  });

  it('disposes the pending resumable transport during shutdown', () => {
    const transport = { closeAll: vi.fn() };

    expect(
      disposePendingConversationRuntime({
        gatewayId: 'gateway-1',
        repository: { offline: false },
        transport,
      } as never),
    ).toBeNull();
    expect(transport.closeAll).toHaveBeenCalledOnce();
  });
});

describe('legacy renderer chat wire adapters', () => {
  const view = {
    id: 'conversation-1',
    agentId: 'agent-1',
    agentName: 'Developer',
    title: 'Local chat',
    revision: 0,
    status: 'idle' as const,
    activeTurnId: null,
    owningIssueId: 'issue-1',
    projectId: null,
    lastSeq: 0,
    lastMessagePreview: 'hello',
    createdAt: '2026-07-12T00:00:00Z',
    updatedAt: '2026-07-12T00:00:01Z',
    origin: 'local' as const,
    offline: false,
    readOnly: false,
  };
  const page = {
    items: [
      {
        id: 'message-1',
        conversationId: view.id,
        turnId: 'legacy:message-1',
        ordinal: 1,
        role: 'user' as const,
        status: 'completed' as const,
        content: { type: 'user' as const, text: 'hello' },
        createdAt: '2026-07-12T00:00:01Z',
        updatedAt: '2026-07-12T00:00:01Z',
      },
    ],
    nextCursor: null,
    throughSeq: 0,
  };

  function makeChat() {
    return {
      listConversations: vi.fn().mockResolvedValue({
        items: [view],
        nextCursor: null,
        authority: 'legacy',
        gatewayOnline: true,
      }),
      createConversation: vi.fn().mockResolvedValue(view),
      getMessages: vi.fn().mockResolvedValue(page),
      renameConversation: vi.fn().mockResolvedValue({ ...view, title: 'Renamed' }),
      deleteConversation: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      answerQuestion: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('routes every current bare-ID chat consumer through an explicit local ref', async () => {
    const chat = makeChat();
    const ids = ['request-1', 'turn-1'];
    const adapter = createLegacyWireChatAdapter(chat, () => ids.shift() as string);

    await expect(adapter.listConversations()).resolves.toEqual([
      {
        id: view.id,
        agentId: view.agentId,
        title: view.title,
        issueId: view.owningIssueId,
        createdAt: view.createdAt,
        updatedAt: view.updatedAt,
      },
    ]);
    await expect(adapter.createConversation('agent-1')).resolves.toMatchObject({ id: view.id });
    await expect(adapter.getMessages(view.id)).resolves.toEqual([
      {
        id: 'message-1',
        role: 'user',
        content: { type: 'user', text: 'hello' },
        timestamp: '2026-07-12T00:00:01Z',
      },
    ]);
    await adapter.renameConversation(view.id, 'Renamed');
    await adapter.deleteConversation(view.id);
    await adapter.sendMessage(view.id, 'hello', [{ mediaType: 'image/png', data: 'aGVsbG8=' }]);
    await adapter.cancel(view.id);
    await adapter.answerQuestion(view.id, 'question-1', 'Yes');

    const ref = { id: view.id, origin: 'local' };
    expect(chat.createConversation).toHaveBeenCalledWith('agent-1', 'request-1');
    expect(chat.getMessages).toHaveBeenCalledWith(ref);
    expect(chat.renameConversation).toHaveBeenCalledWith(ref, 0, 'Renamed');
    expect(chat.deleteConversation).toHaveBeenCalledWith(ref, 0);
    expect(chat.sendMessage).toHaveBeenCalledWith(ref, 'turn-1', 'hello', [
      { mediaType: 'image/png', data: 'aGVsbG8=' },
    ]);
    expect(chat.cancel).toHaveBeenCalledWith(ref, undefined);
    expect(chat.answerQuestion).toHaveBeenCalledWith(ref, undefined, 'question-1', 'Yes');
  });
});

describe('projects assignment canonical IDs and refs', () => {
  it('allocates stable request/turn IDs, preserves origin internally, and unwraps only for HTTP/IPC', async () => {
    const conversation = { id: 'shared-id', origin: 'gateway' as const };
    const client = {
      getIssue: vi.fn().mockResolvedValue({
        id: 'issue-1',
        key: 'TASK-1',
        title: 'Fix it',
        project_id: 'project-1',
      }),
      linkSession: vi.fn().mockResolvedValue(undefined),
      patchIssue: vi.fn().mockResolvedValue(undefined),
    };
    const chat = {
      createConversation: vi.fn().mockResolvedValue({
        id: conversation.id,
        origin: conversation.origin,
      }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const ids = ['request-project', 'turn-project'];

    await expect(
      projectsAssignAgentHandler(
        client,
        chat,
        'TASK-1',
        'agent-1',
        'Developer',
        () => ids.shift() as string,
      ),
    ).resolves.toBe(conversation.id);

    expect(chat.createConversation).toHaveBeenCalledWith('agent-1', 'request-project', {
      title: 'TASK-1 — Fix it',
      owningIssueId: 'issue-1',
      projectId: 'project-1',
    });
    expect(client.linkSession).toHaveBeenCalledWith('issue-1', conversation.id, 'Developer');
    expect(chat.sendMessage).toHaveBeenCalledWith(
      conversation,
      'turn-project',
      expect.stringContaining('TASK-1'),
    );
  });
});

describe('remote gateway capability verification wiring', () => {
  it('requires identity from a capable gateway', async () => {
    const identity = { gatewayId: 'gateway-01', publicKey: 'dash-test-public-key' };
    const client = {
      health: vi.fn().mockResolvedValue({
        status: 'healthy',
        startedAt: '2026-07-12T00:00:00.000Z',
        agents: 1,
        channels: 1,
        apiVersion: 1,
        capabilities: ['conversation-sync-v1', 'chat-resume-v1'],
      }),
      getIdentity: vi.fn().mockResolvedValue(identity),
    };

    await expect(verifyConversationGateway(client)).resolves.toMatchObject({ identity });
    expect(client.getIdentity).toHaveBeenCalledOnce();
  });

  it('does not probe identity on an explicitly old gateway', async () => {
    const client = {
      health: vi.fn().mockResolvedValue({
        status: 'healthy',
        startedAt: '2026-07-12T00:00:00.000Z',
        agents: 1,
        channels: 1,
      }),
      getIdentity: vi.fn(),
    };

    await expect(verifyConversationGateway(client)).resolves.toEqual({
      identity: null,
      apiVersion: 0,
      capabilities: [],
    });
    expect(client.getIdentity).not.toHaveBeenCalled();
  });
});

describe('enrollGateway', () => {
  it('reads the gateway pubkey, claims the subdomain, persists {id,subdomain,host}, restarts', async () => {
    const keychain = new InMemoryKeychainStore();
    const getRelayIdentity = vi.fn().mockResolvedValue({ publicKey: 'pubkey-b64' });
    const ensureRunning = vi.fn().mockResolvedValue({ getRelayIdentity });
    const restart = vi.fn().mockResolvedValue(undefined);
    const createGateway = vi.fn().mockResolvedValue({
      gatewayId: 'alice-mbp',
      subdomain: 'alice-mbp.relay.dash.example',
      dialToken: 'dial-1',
    });

    await enrollGateway({
      subdomain: 'alice-mbp',
      ensureRunning,
      restart,
      keychain,
      controlPlaneClient: { createGateway } as never,
    });

    // Pubkey read over loopback, then label claimed with that pubkey.
    expect(getRelayIdentity).toHaveBeenCalledOnce();
    expect(createGateway).toHaveBeenCalledWith('alice-mbp', 'pubkey-b64');
    // host is the bare zone (subdomain minus the `<gatewayId>.` prefix).
    expect(await keychain.getIssuedGateway()).toEqual({
      gatewayId: 'alice-mbp',
      subdomain: 'alice-mbp.relay.dash.example',
      host: 'relay.dash.example',
      dialToken: 'dial-1',
    });
    // Relay mode is applied through a restart.
    expect(restart).toHaveBeenCalledOnce();
  });
});

describe('makePackagedSpawner', () => {
  it('replaces node with execPath and adds ELECTRON_RUN_AS_NODE=1 when packaged', () => {
    const spawned: { command: string; env: Record<string, string | undefined> }[] = [];
    const testSpawner = {
      spawn: (
        command: string,
        args: string[],
        options: { env?: Record<string, string | undefined> },
      ) => {
        spawned.push({ command, env: options.env ?? {} });
        return { exitCode: null, kill: vi.fn(), on: vi.fn(), stdout: null, stderr: null };
      },
    };

    const fakeExecPath = '/Applications/Dash.app/Contents/MacOS/Dash';
    const packaged = makePackagedSpawner(fakeExecPath, testSpawner, true);
    packaged.spawn('node', ['script.js'], { env: { FOO: 'bar' } });

    expect(spawned[0].command).toBe(fakeExecPath);
    expect(spawned[0].env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(spawned[0].env.FOO).toBe('bar');
  });

  it('passes through to base spawner when not packaged', () => {
    const spawned: { command: string }[] = [];
    const testSpawner = {
      spawn: (command: string, _args: string[], _options: object) => {
        spawned.push({ command });
        return { exitCode: null, kill: vi.fn(), on: vi.fn(), stdout: null, stderr: null };
      },
    };

    const notPackaged = makePackagedSpawner('/path/to/electron', testSpawner, false);
    notPackaged.spawn('node', ['script.js'], { env: {} });

    expect(spawned[0].command).toBe('node');
  });
});

describe('shutdownGatewayOnQuit', () => {
  // Regression guard: the quit handler used to call `store.clear()` here,
  // which deleted gateway-state.json on every MC shutdown. The file
  // doubles as the "first-run detection" signal at boot, so clearing it
  // made every subsequent launch re-trip the setup-wizard deferral path.
  // Fix: kill the process but leave the file. ensureRunning() cleans up
  // the stale record on next launch when it probes the now-free port.
  let tmpDir: string;
  let stateFile: string;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mc-shutdown-'));
    stateFile = join(tmpDir, 'gateway-state.json');
    // Swallow SIGTERMs — the function calls process.kill on a fake pid
    // and we don't want to actually signal real processes in the runner.
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(async () => {
    killSpy.mockRestore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeState(state: {
    pid: number;
    startedAt: string;
    port: number;
    channelPort: number;
  }): Promise<void> {
    await writeFile(stateFile, JSON.stringify(state, null, 2));
  }

  it('leaves gateway-state.json on disk so first-run detection stays stable', async () => {
    await writeState({
      pid: 12345,
      startedAt: '2026-01-01T00:00:00Z',
      port: 9100,
      channelPort: 9101,
    });
    expect(existsSync(stateFile)).toBe(true);

    await shutdownGatewayOnQuit(tmpDir);

    // The file MUST still exist — that's the whole fix.
    expect(existsSync(stateFile)).toBe(true);
    // Contents unchanged too — no accidental rewrite.
    const raw = await readFile(stateFile, 'utf-8');
    expect(JSON.parse(raw)).toEqual({
      pid: 12345,
      startedAt: '2026-01-01T00:00:00Z',
      port: 9100,
      channelPort: 9101,
    });
  });

  it('sends SIGTERM to the recorded pid', async () => {
    await writeState({
      pid: 99999,
      startedAt: '2026-01-01T00:00:00Z',
      port: 9100,
      channelPort: 9101,
    });

    await shutdownGatewayOnQuit(tmpDir);

    expect(killSpy).toHaveBeenCalledWith(99999, 'SIGTERM');
  });

  it('is a no-op when there is no existing gateway state', async () => {
    // No state file written — function should return cleanly.
    await expect(shutdownGatewayOnQuit(tmpDir)).resolves.toBeUndefined();
    expect(killSpy).not.toHaveBeenCalled();
    // Still no file afterwards.
    expect(existsSync(stateFile)).toBe(false);
  });

  it('swallows ESRCH from process.kill when the pid is already dead', async () => {
    killSpy.mockImplementation(() => {
      const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    await writeState({
      pid: 123,
      startedAt: '2026-01-01T00:00:00Z',
      port: 9100,
      channelPort: 9101,
    });

    // Must not throw — the handler treats "already dead" as normal.
    await expect(shutdownGatewayOnQuit(tmpDir)).resolves.toBeUndefined();

    // And the file is still there — this is the behavior we care about.
    expect(existsSync(stateFile)).toBe(true);
  });
});

describe('isSetupConfigured', () => {
  it('true when setupCompletedAt is present', () => {
    expect(isSetupConfigured({ setupCompletedAt: '2026-06-21T00:00:00.000Z' }, false)).toBe(true);
  });

  it('true when legacy gateway-state.json exists', () => {
    expect(isSetupConfigured({}, true)).toBe(true);
  });

  it('false when neither flag nor legacy file', () => {
    expect(isSetupConfigured({}, false)).toBe(false);
  });
});

describe('resolveSetupStatus', () => {
  const healthyClient = { listCredentials: async () => ['anthropic-api-key:default'] };

  it('returns needs-setup when not configured and does not touch the gateway', async () => {
    const ensureHealthyClient = vi.fn();
    const result = await resolveSetupStatus({
      isConfigured: async () => false,
      ensureHealthyClient,
      markSetupCompleted: vi.fn(),
    });
    expect(result).toEqual({ state: 'needs-setup' });
    expect(ensureHealthyClient).not.toHaveBeenCalled();
  });

  it('returns ready and marks complete when configured + healthy + has creds', async () => {
    const markSetupCompleted = vi.fn().mockResolvedValue(undefined);
    const result = await resolveSetupStatus({
      isConfigured: async () => true,
      ensureHealthyClient: async () => healthyClient,
      markSetupCompleted,
    });
    expect(result).toEqual({ state: 'ready' });
    expect(markSetupCompleted).toHaveBeenCalledOnce();
  });

  it('returns needs-setup when configured + healthy but no credentials', async () => {
    const result = await resolveSetupStatus({
      isConfigured: async () => true,
      ensureHealthyClient: async () => ({ listCredentials: async () => [] }),
      markSetupCompleted: vi.fn(),
    });
    expect(result).toEqual({ state: 'needs-setup' });
  });

  it('returns gateway-failed with the error message when the client throws', async () => {
    const result = await resolveSetupStatus({
      isConfigured: async () => true,
      ensureHealthyClient: async () => {
        throw new Error('Gateway failed to start within 10s');
      },
      markSetupCompleted: vi.fn(),
    });
    expect(result).toEqual({
      state: 'gateway-failed',
      error: 'Gateway failed to start within 10s',
    });
  });
});

describe('plugin IPC handlers', () => {
  // These mirror the management-client passthrough handlers registered in
  // registerIpcHandlers. They take an already-resolved ManagementClient so we
  // can assert the real behavior (record unwrapping, argument forwarding)
  // without booting Electron.
  const sampleRecord = {
    name: 'acme',
    status: 'loaded' as const,
    enabled: true,
    trusted: false,
    activated: ['skills'],
    noop: [],
  };

  it('pluginsListHandler unwraps the { records } envelope', async () => {
    const client = {
      pluginsList: vi.fn().mockResolvedValue({ records: [sampleRecord] }),
    };
    const result = await pluginsListHandler(client);
    expect(client.pluginsList).toHaveBeenCalledOnce();
    expect(result).toEqual([sampleRecord]);
  });

  it('pluginSetStateHandler forwards (name, patch) and returns the record', async () => {
    const updated = { ...sampleRecord, trusted: true };
    const client = { pluginSetState: vi.fn().mockResolvedValue(updated) };
    const patch = { trusted: true };
    const result = await pluginSetStateHandler(client, 'acme', patch);
    expect(client.pluginSetState).toHaveBeenCalledWith('acme', patch);
    expect(result).toBe(updated);
  });

  it('pluginInstallHandler forwards req.source and req.name', async () => {
    const installed = {
      name: 'acme',
      location: '/data/plugins/acme',
      scanVerdict: 'safe' as const,
      scanReasons: [],
      source: 'git:acme/acme',
    };
    const client = { pluginInstall: vi.fn().mockResolvedValue(installed) };
    const result = await pluginInstallHandler(client, {
      source: 'git:acme/acme',
      name: 'override',
    });
    expect(client.pluginInstall).toHaveBeenCalledWith('git:acme/acme', 'override');
    expect(result).toBe(installed);
  });

  it('pluginInstallHandler passes undefined name when omitted', async () => {
    const client = { pluginInstall: vi.fn().mockResolvedValue({}) };
    await pluginInstallHandler(client, { source: 'git:acme/acme' });
    expect(client.pluginInstall).toHaveBeenCalledWith('git:acme/acme', undefined);
  });

  it('pluginRemoveHandler calls pluginRemove(name)', async () => {
    const client = {
      pluginRemove: vi.fn().mockResolvedValue({ ok: true, path: '/data/plugins/acme' }),
    };
    const result = await pluginRemoveHandler(client, 'acme');
    expect(client.pluginRemove).toHaveBeenCalledWith('acme');
    expect(result).toEqual({ ok: true, path: '/data/plugins/acme' });
  });

  it('pluginReloadHandler calls pluginReload()', async () => {
    const client = {
      pluginReload: vi.fn().mockResolvedValue({ ok: true, reloadedAt: '2026-06-21T00:00:00Z' }),
    };
    const result = await pluginReloadHandler(client);
    expect(client.pluginReload).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, reloadedAt: '2026-06-21T00:00:00Z' });
  });

  it('pluginRuntimeHandler calls runtimePlugins() and returns its result', async () => {
    const runtime = {
      providers: [{ id: 'acme', label: 'Acme', credentialPrefix: 'ACME_' }],
      plugins: [{ name: 'acme', displayName: 'Acme', version: '1.2.3' }],
    };
    const client = { runtimePlugins: vi.fn().mockResolvedValue(runtime) };
    const result = await pluginRuntimeHandler(client);
    expect(client.runtimePlugins).toHaveBeenCalledOnce();
    expect(result).toBe(runtime);
  });
});
