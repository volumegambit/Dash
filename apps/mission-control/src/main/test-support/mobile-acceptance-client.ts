import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConversationStore,
  GatewayConversationCache,
  GatewayConversationRepository,
  GatewayManagementClient,
  LegacyConversationRepository,
} from '@dash/mc';
import type { ConversationRef, McConversationView } from '@dash/mc';
import type {
  ConversationMessage,
  MobileApiErrorCode,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
import {
  mergeCanonicalMessages,
  replaceAcceptedOptimisticMessage,
} from '../../renderer/src/stores/chat-sync.js';
import { ChatService } from '../chat-service.js';
import { ConversationController } from '../conversation-controller.js';
import {
  ResumableChatTransport,
  ResumableChatTransportError,
} from '../resumable-chat-transport.js';

type TerminalFrame = Extract<MobileWsServerFrame, { type: 'done' | 'error' }>;

interface MobileAcceptanceHarness {
  managementBaseUrl: string;
  chatWebSocketUrl: string;
  managementToken: string;
  chatToken: string;
  agentId: string;
}

export interface MissionControlAcceptanceClient {
  create(requestId: string): Promise<McConversationView>;
  send(conversation: McConversationView, turnId: string, text: string): Promise<string>;
  expectBusy(conversation: McConversationView, turnId: string): Promise<MobileApiErrorCode>;
  messages(conversation: McConversationView): Promise<ConversationMessage[]>;
  refresh(): Promise<McConversationView[]>;
  rename(
    conversation: McConversationView,
    revision: number,
    title: string,
  ): Promise<McConversationView>;
  cancel(conversation: McConversationView, turnId: string): Promise<'completed' | 'cancelled'>;
  deleteAgent(agentId: string): Promise<void>;
  conversation(conversation: McConversationView): Promise<McConversationView>;
  close(): Promise<void>;
}

function ref(conversation: Pick<McConversationView, 'id'>): ConversationRef {
  return { id: conversation.id, origin: 'gateway' };
}

function waitForTerminal(
  frames: MobileWsServerFrame[],
  turnId: string,
  timeoutMs = 10_000,
): Promise<TerminalFrame> {
  const current = frames.find(
    (frame): frame is TerminalFrame =>
      frame.id === turnId && (frame.type === 'done' || frame.type === 'error'),
  );
  if (current) return Promise.resolve(current);

  return new Promise<TerminalFrame>((resolve, reject) => {
    const startedAt = Date.now();
    const poll = (): void => {
      const terminal = frames.find(
        (frame): frame is TerminalFrame =>
          frame.id === turnId && (frame.type === 'done' || frame.type === 'error'),
      );
      if (terminal) {
        resolve(terminal);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for terminal frame for turn ${turnId}`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

async function waitForCanonicalTerminal(
  controller: ConversationController,
  conversation: McConversationView,
  timeoutMs = 10_000,
): Promise<McConversationView> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = await controller.find(ref(conversation));
    if (current && current.activeTurnId === null && current.status !== 'running') return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for canonical terminal state for ${conversation.id}`);
}

export function assertDurableFrameIdentity(
  frame: MobileWsServerFrame,
  expected: { conversationId: string; turnId: string },
): void {
  if (frame.id !== expected.turnId) {
    throw new Error(`Received unexpected turn "${frame.id}"; expected "${expected.turnId}"`);
  }
  if (!('conversationId' in frame) || frame.conversationId !== expected.conversationId) {
    throw new Error(
      `Received unexpected conversation "${String('conversationId' in frame ? frame.conversationId : undefined)}"; ` +
        `expected "${expected.conversationId}"`,
    );
  }
  if (
    !('seq' in frame) ||
    typeof frame.seq !== 'number' ||
    !Number.isSafeInteger(frame.seq) ||
    frame.seq < 1
  ) {
    throw new Error(`Received non-durable frame for turn "${expected.turnId}"`);
  }
}

export function createAcceptanceTransportFailureMonitor(): {
  onConnectionError(conversationId: string, error: Error): void;
  onProtocolError(conversationId: string, message: string): void;
  assertHealthy(): void;
} {
  let failure: Error | null = null;
  return {
    onConnectionError(_conversationId, error) {
      failure ??= error;
    },
    onProtocolError(conversationId, message) {
      failure ??= new Error(`Conversation "${conversationId}" protocol failure: ${message}`);
    },
    assertHealthy() {
      if (failure) throw failure;
    },
  };
}

export async function withAcceptanceDataDir<T>(
  initialize: (dataDir: string) => Promise<T>,
): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), 'dash-mc-mobile-acceptance-'));
  try {
    return await initialize(dataDir);
  } catch (error) {
    try {
      await rm(dataDir, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Mission Control acceptance initialization and cleanup failed',
      );
    }
    throw error;
  }
}

export async function startMissionControlAcceptanceClient(
  harness: MobileAcceptanceHarness,
): Promise<MissionControlAcceptanceClient> {
  const { dataDir, store, management, controller } = await withAcceptanceDataDir(
    async (dataDir) => {
      const store = new ConversationStore(dataDir);
      const management = new GatewayManagementClient(
        harness.managementBaseUrl,
        harness.managementToken,
      );
      const [health, identity] = await Promise.all([management.health(), management.getIdentity()]);
      const cache = new GatewayConversationCache(dataDir, identity.gatewayId);
      const gateway = new GatewayConversationRepository(identity.gatewayId, management, cache);
      const legacy = new LegacyConversationRepository(store, (agentId) => agentId);
      const controller = new ConversationController(legacy);
      controller.configure({
        gatewayId: identity.gatewayId,
        online: true,
        capabilities: health.capabilities ?? [],
        repository: gateway,
      });
      return { dataDir, store, management, controller };
    },
  );

  const failureMonitor = createAcceptanceTransportFailureMonitor();
  const assertHealthy = (): void => failureMonitor.assertHealthy();
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertHealthy();
    const result = await operation();
    assertHealthy();
    return result;
  };

  const frames: MobileWsServerFrame[] = [];
  const projectedMessages = new Map<string, ConversationMessage[]>();
  const transport = new ResumableChatTransport({
    connection: {
      url: `${harness.chatWebSocketUrl}?token=${encodeURIComponent(harness.chatToken)}`,
    },
    channelId: 'mission-control',
    replay: (conversation, agentId, sinceSeq) => controller.replay(conversation, agentId, sinceSeq),
    onFrame: (frame) => frames.push(frame),
    onConnectionError: failureMonitor.onConnectionError,
    onProtocolError: failureMonitor.onProtocolError,
  });
  const chat = new ChatService(
    store,
    () => {},
    () => {},
    () => {},
    undefined,
    undefined,
    controller,
    transport,
  );
  let closed = false;

  return {
    async create(requestId) {
      return checked(() => chat.createConversation(harness.agentId, requestId));
    },

    async send(conversation, turnId, text) {
      assertHealthy();
      const now = new Date().toISOString();
      projectedMessages.set(conversation.id, [
        {
          id: `optimistic:${turnId}`,
          conversationId: conversation.id,
          turnId,
          ordinal: Number.MAX_SAFE_INTEGER,
          role: 'user',
          status: 'accepted',
          content: { type: 'user', text },
          createdAt: now,
          updatedAt: now,
        },
      ]);
      const accepted = await chat.sendMessage(ref(conversation), turnId, text);
      if (!accepted) throw new Error('Capable Mission Control send was not durably accepted');
      assertDurableFrameIdentity(accepted, { conversationId: conversation.id, turnId });
      assertHealthy();
      projectedMessages.set(
        conversation.id,
        replaceAcceptedOptimisticMessage(projectedMessages.get(conversation.id) ?? [], accepted),
      );
      return accepted.id;
    },

    async expectBusy(conversation, turnId) {
      assertHealthy();
      try {
        await chat.sendMessage(ref(conversation), turnId, 'Competing desktop turn');
      } catch (error) {
        if (error instanceof ResumableChatTransportError && error.code === 'conversation_busy') {
          assertHealthy();
          return error.code;
        }
        throw error;
      }
      throw new Error('Competing desktop turn was unexpectedly accepted');
    },

    async messages(conversation) {
      const page = await checked(() => chat.getMessages(ref(conversation)));
      const merged = mergeCanonicalMessages(
        projectedMessages.get(conversation.id) ?? [],
        page.items,
      );
      projectedMessages.set(conversation.id, merged);
      return merged;
    },

    async refresh() {
      return (await checked(() => chat.listConversations())).items;
    },

    async rename(conversation, revision, title) {
      return checked(() => chat.renameConversation(ref(conversation), revision, title));
    },

    async cancel(conversation, turnId) {
      await checked(() => chat.getMessages(ref(conversation)));
      await checked(() => chat.cancel(ref(conversation), turnId));
      const terminal = await waitForTerminal(frames, turnId);
      assertDurableFrameIdentity(terminal, { conversationId: conversation.id, turnId });
      if (terminal.type === 'error') throw new Error(terminal.error);
      await waitForCanonicalTerminal(controller, conversation);
      assertHealthy();
      return terminal.outcome ?? 'completed';
    },

    async deleteAgent(agentId) {
      return checked(() => management.removeAgent(agentId));
    },

    async conversation(conversation) {
      const current = await checked(() => controller.find(ref(conversation)));
      if (!current) throw new Error(`Conversation "${conversation.id}" not found`);
      return current;
    },

    async close() {
      if (closed) {
        assertHealthy();
        return;
      }
      closed = true;
      chat.setResumableTransport(undefined);
      transport.closeAll();
      await rm(dataDir, { recursive: true, force: true });
      assertHealthy();
    },
  };
}
