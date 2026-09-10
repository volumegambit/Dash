// @vitest-environment node

import type { MobileV2ConversationSummary, MobileV2SequencedFrame } from '@dash/mobile-contract-v2';
import { describe, expect, it, vi } from 'vitest';
import { startMobileTestHarness } from '../../../gateway/src/mobile-test-harness.js';
import {
  type V2ConversationProjection,
  applyV2Frame,
  projectionFromBootstrap,
} from '../renderer/src/stores/chat-v2-sync.js';
import { ConversationChatTransport } from './conversation-chat-transport.js';
import type { ChatSocket, ChatSocketFactory } from './resumable-chat-transport.js';

describe('Mission Control Follow Up v2 cross-client sync', () => {
  it('converges two direct v2 transports through queue mutation, Stop, pause/resume, and reconnect', async () => {
    const { default: RealWebSocket } = await vi.importActual<typeof import('ws')>('ws');
    const harness = await startMobileTestHarness({ scenario: 'follow-up-v2-restart' });
    const nextId = (): string => crypto.randomUUID();
    let firstClient: ReturnType<typeof createClient> | undefined;
    let secondClient: ReturnType<typeof createClient> | undefined;

    function createClient(
      channelId: string,
      connectionUrl: string,
      initial: V2ConversationProjection,
    ) {
      let projection = initial;
      const frames: MobileV2SequencedFrame[] = [];
      const gaps: number[] = [];
      const connectionErrors: Error[] = [];
      const commandErrors: Error[] = [];
      const sockets: InstanceType<typeof RealWebSocket>[] = [];
      const socketFactory: ChatSocketFactory = (url, options) => {
        const created = new RealWebSocket(url, { headers: options.headers });
        sockets.push(created);
        return created as unknown as ChatSocket;
      };
      const transport = new ConversationChatTransport({
        connection: { url: connectionUrl },
        channelId,
        socketFactory,
        onFrame(frame) {
          frames.push(frame);
          const applied = applyV2Frame(projection, frame);
          if (applied.gapAfter !== null) gaps.push(applied.gapAfter);
          else projection = applied.state;
        },
        onConnectionError(_conversationId, error) {
          connectionErrors.push(error);
        },
        onCommandError(_conversationId, error) {
          commandErrors.push(error);
        },
      });
      return {
        transport,
        frames,
        gaps,
        connectionErrors,
        commandErrors,
        sockets,
        projection: () => projection,
      };
    }

    function messageIds(frames: MobileV2SequencedFrame[]): string[] {
      const ids: string[] = [];
      for (const frame of frames) {
        if (frame.type === 'accepted' || frame.type === 'input_delivered') {
          ids.push(frame.userMessageId, frame.assistantMessageId);
        }
      }
      return ids;
    }

    try {
      const createResponse = await fetch(`${harness.managementBaseUrl}/mobile/v2/conversations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${harness.chatToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ agentId: harness.agentId, requestId: nextId() }),
      });
      expect(createResponse.status).toBe(201);
      const conversation = (await createResponse.json()) as MobileV2ConversationSummary;
      const bootstrap = await harness.bootstrapV2(conversation.id);
      const connectionUrl = `${harness.chatWebSocketUrl}?token=${encodeURIComponent(
        harness.chatToken,
      )}`;
      firstClient = createClient(
        'mission-control-integration-a',
        connectionUrl,
        projectionFromBootstrap(bootstrap),
      );
      secondClient = createClient(
        'mission-control-integration-b',
        connectionUrl,
        projectionFromBootstrap(bootstrap),
      );
      await Promise.all([
        firstClient.transport.open(conversation, bootstrap.v2ThroughSeq),
        secondClient.transport.open(conversation, bootstrap.v2ThroughSeq),
      ]);

      const outerRunId = nextId();
      harness.holdProviderGate(outerRunId, 'beforeRunTerminal');
      await firstClient.transport.send(conversation, outerRunId, 'Hold this response open');
      await harness.waitForProviderGate(outerRunId, 'beforeSafeBoundary');

      const first = await firstClient.transport.enqueueInput(conversation, {
        commandId: nextId(),
        inputId: nextId(),
        behavior: 'followUp',
        text: 'first queued item',
      });
      const second = await firstClient.transport.enqueueInput(conversation, {
        commandId: nextId(),
        inputId: nextId(),
        behavior: 'followUp',
        text: 'second queued item',
      });
      await secondClient.transport.editFollowUp(conversation, {
        commandId: nextId(),
        inputId: second.input.inputId,
        expectedRevision: second.input.revision,
        text: 'second item edited remotely',
      });

      secondClient.sockets[0]?.terminate();
      await vi.waitFor(() =>
        expect(secondClient?.sockets[0]?.readyState).toBe(RealWebSocket.CLOSED),
      );
      const third = await secondClient.transport.enqueueInput(conversation, {
        commandId: nextId(),
        inputId: nextId(),
        behavior: 'followUp',
        text: 'remove after reconnect',
      });
      expect(secondClient.sockets.length).toBeGreaterThanOrEqual(2);
      await firstClient.transport.removeFollowUp(
        conversation,
        nextId(),
        third.input.inputId,
        third.input.revision,
      );

      const firstRunId = first.input.runId;
      const secondRunId = second.input.runId;
      if (!firstRunId || !secondRunId) throw new Error('Gateway did not reserve Follow Up runs');
      harness.failRun(firstRunId);
      harness.holdProviderGate(firstRunId, 'beforeRunTerminal');
      harness.holdProviderGate(secondRunId, 'beforeRunTerminal');
      firstClient.transport.cancel(conversation.id, outerRunId);
      await vi.waitFor(() =>
        expect(
          firstClient?.frames.some(
            (frame) =>
              frame.type === 'done' && frame.runId === outerRunId && frame.outcome === 'cancelled',
          ),
        ).toBe(true),
      );
      await harness.waitForProviderGate(firstRunId, 'beforeRunTerminal');
      harness.releaseProviderGate(firstRunId, 'beforeRunTerminal');
      await vi.waitFor(() => {
        expect(firstClient?.frames.some((frame) => frame.type === 'queue_paused')).toBe(true);
        expect(secondClient?.frames.some((frame) => frame.type === 'queue_paused')).toBe(true);
      });

      await secondClient.transport.resumeFollowUps(
        conversation,
        nextId(),
        secondClient.projection().queueRevision,
      );
      await harness.waitForProviderGate(secondRunId, 'beforeRunTerminal');
      harness.releaseProviderGate(secondRunId, 'beforeRunTerminal');
      await vi.waitFor(() => {
        expect(
          firstClient?.frames.some((frame) => frame.type === 'done' && frame.runId === secondRunId),
        ).toBe(true);
        expect(
          secondClient?.frames.some(
            (frame) => frame.type === 'done' && frame.runId === secondRunId,
          ),
        ).toBe(true);
      });

      const finalBootstrap = await harness.bootstrapV2(conversation.id);
      await vi.waitFor(() => {
        expect(firstClient?.projection().lastAppliedV2Seq).toBe(finalBootstrap.v2ThroughSeq);
        expect(secondClient?.projection().lastAppliedV2Seq).toBe(finalBootstrap.v2ThroughSeq);
      });
      expect(firstClient.gaps).toEqual([]);
      expect(secondClient.gaps).toEqual([]);
      expect(firstClient.connectionErrors).toEqual([]);
      expect(secondClient.connectionErrors).toEqual([]);
      expect(firstClient.commandErrors).toEqual([]);
      expect(secondClient.commandErrors).toEqual([]);
      expect(firstClient.projection().queueRevision).toBe(finalBootstrap.queueRevision);
      expect(secondClient.projection().queueRevision).toBe(finalBootstrap.queueRevision);
      expect(firstClient.projection().queueOrder).toEqual([]);
      expect(secondClient.projection().queueOrder).toEqual([]);

      const firstSeqs = firstClient.frames.map((frame) => frame.v2Seq);
      const secondSeqs = secondClient.frames.map((frame) => frame.v2Seq);
      expect(new Set(firstSeqs).size).toBe(firstSeqs.length);
      expect(new Set(secondSeqs).size).toBe(secondSeqs.length);
      const firstIds = [...new Set(messageIds(firstClient.frames))].sort();
      const secondIds = [...new Set(messageIds(secondClient.frames))].sort();
      const canonicalIds = finalBootstrap.messages.map((message) => message.id).sort();
      expect(firstIds).toEqual(secondIds);
      expect(firstIds).toEqual(canonicalIds);
    } finally {
      firstClient?.transport.closeAll();
      secondClient?.transport.closeAll();
      await harness.stop();
    }
  }, 30_000);
});
