import type { McConversationView } from '@dash/mc';
import type { MobileWsServerFrame } from '@dash/mobile-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../../vitest.setup.js';
import { useChatStore } from '../renderer/src/stores/chat.js';
import {
  type ChatSocket,
  type ChatSocketEvent,
  ResumableChatTransport,
} from './resumable-chat-transport.js';

/**
 * Ruling 4's seam, and the only test on this branch that spans both halves of
 * the live child transcript.
 *
 * The transport's socket lifecycle and the store's routing are each unit-tested
 * on their own side, against frames written by hand. Web's D2 review found that
 * two correct halves can still be joined wrongly and nothing would say so, so
 * this drives a real frame through the real `watchConversation` path, over the
 * serialization `webContents.send` performs, into the store that consumes it.
 *
 * It lives under `src/main/` because that is the only project allowed to import
 * the transport: `tsconfig.web.json` includes `src/renderer` and `src/shared`
 * and nothing else, which is the boundary that sent this test here.
 */
class FakeChatSocket implements ChatSocket {
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Array<(event: ChatSocketEvent) => void>>();

  addEventListener(name: string, listener: (event: ChatSocketEvent) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', { code: 1000, reason: 'client close' });
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  deliver(frame: MobileWsServerFrame): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  private emit(name: string, event: ChatSocketEvent): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

const parent: McConversationView = {
  id: 'parent-1',
  agentId: 'agent-1',
  agentName: 'Gateway Agent',
  title: 'Gateway conversation',
  revision: 2,
  status: 'idle',
  activeTurnId: null,
  owningIssueId: null,
  projectId: null,
  lastSeq: 0,
  lastMessagePreview: '',
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
  kind: 'user',
  origin: 'gateway',
  offline: false,
  readOnly: false,
};

const acceptedFrame = {
  type: 'accepted',
  id: 'child-turn-1',
  conversationId: 'sub_a',
  userMessageId: 'child-user-1',
  assistantMessageId: 'child-assistant-1',
  revision: 3,
  seq: 41,
} as MobileWsServerFrame;

const eventFrame = {
  type: 'event',
  id: 'child-turn-1',
  conversationId: 'sub_a',
  seq: 42,
  event: { type: 'text_delta', text: 'from the wire' },
} as MobileWsServerFrame;

describe('the child frame seam', () => {
  beforeEach(() => {
    useChatStore.setState({
      selectedConversationRef: { id: 'parent-1', origin: 'gateway' },
      conversations: [parent],
      messages: {},
      streamingFrames: {},
      lastSeq: {},
      subagents: [],
      subagentUi: {},
    });
  });

  it("carries a watched child's frame from the transport into that card", async () => {
    useChatStore.getState().subscribeSubagent('sub_a');
    expect(mockApi.subagentSubscribe).toHaveBeenCalledWith('agent-1', 'sub_a');

    const sockets: FakeChatSocket[] = [];
    const transport = new ResumableChatTransport({
      connection: { url: 'wss://gateway.example.com/ws/chat' },
      channelId: 'mission-control',
      replay: vi.fn().mockResolvedValue([]),
      // Exactly what `main/ipc.ts` wires: `onFrame` → `webContents.send`. The
      // JSON round trip stands in for the structured clone, so nothing here can
      // depend on object identity across the hop.
      onFrame: (frame) => {
        void useChatStore
          .getState()
          .applyFrame(JSON.parse(JSON.stringify(frame)) as MobileWsServerFrame);
      },
      onConnectionError: vi.fn(),
      onProtocolError: vi.fn(),
      socketFactory: () => {
        const socket = new FakeChatSocket();
        sockets.push(socket);
        return socket;
      },
    });

    transport.watchConversation('agent-1', 'sub_a');
    sockets[0].open();
    expect(sockets[0].sent[0]).toMatchObject({ type: 'subscribe', conversationId: 'sub_a' });

    sockets[0].deliver(acceptedFrame);
    sockets[0].deliver(eventFrame);

    await vi.waitFor(() =>
      expect(useChatStore.getState().subagentUi.sub_a?.transcript).toHaveLength(1),
    );
    expect(useChatStore.getState().subagentUi.sub_a.transcript?.[0]).toMatchObject({
      id: 'child-assistant-1',
      turnId: 'child-turn-1',
      status: 'streaming',
      content: { type: 'assistant', events: [{ type: 'text_delta', text: 'from the wire' }] },
    });
    // The child's own key, and the parent's, both untouched.
    expect(useChatStore.getState().streamingFrames['gateway:sub_a']).toBeUndefined();
    expect(useChatStore.getState().streamingFrames['gateway:parent-1']).toBeUndefined();

    useChatStore.getState().unsubscribeSubagent('sub_a');
    transport.closeAll();
  });
});
