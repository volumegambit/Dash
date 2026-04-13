import { randomUUID } from 'node:crypto';
import type { ConversationStore, McConversation, McMessage } from '@dash/mc';
import WebSocket from 'ws';
import type { McAgentEvent } from '../shared/ipc.js';

export interface GatewayConnection {
  channelPort: number;
  chatToken?: string;
  /**
   * Base URL of the gateway's management HTTP API (e.g.
   * "http://127.0.0.1:9300"). Used for the replay endpoint that
   * fetches missing chat events after a WebSocket drop. Optional
   * for backwards-compat with any caller that only needs chat
   * streaming; when missing, reconciliation is silently skipped.
   */
  managementBaseUrl?: string;
  /**
   * Bearer token for the gateway's management API. Read from the
   * OS keychain via `GatewaySupervisor.getGatewayToken()` in the
   * main process, not stored anywhere else.
   */
  managementToken?: string;
}

/**
 * Minimal local shape of an entry from the gateway's event log
 * replay endpoint. Declared here (not imported from @dash/agent or
 * the gateway package) so the MC main process doesn't depend on
 * gateway-internal types. The wire format is stable because it's
 * owned by the public `/agents/:id/conversations/:id/events`
 * contract.
 */
interface ReplayedEventLogEntry {
  seq: number;
  msgId: string;
  agentId: string;
  conversationId: string;
  timestamp: string;
  payload:
    | { type: 'event'; event: McAgentEvent }
    | { type: 'done' }
    | { type: 'error'; error: string };
}

export class ChatService {
  private activeStreams = new Map<string, { ws: WebSocket; msgId: string }>();

  constructor(
    private store: ConversationStore,
    private onEvent: (conversationId: string, event: McAgentEvent) => void,
    private onDone: (conversationId: string) => void,
    private onError: (conversationId: string, error: string) => void,
    private gatewayConnection?: GatewayConnection,
  ) {}

  setGatewayConnection(connection: GatewayConnection): void {
    this.gatewayConnection = connection;
  }

  /**
   * Fetch any events the gateway logged for this conversation since
   * `sinceSeq`. Called from the close handler of a dropped chat
   * WebSocket to recover events that were streamed during the gap.
   *
   * Returns an empty array on any failure (no management connection,
   * network error, non-2xx response) — callers fall back to saving
   * whatever partial state they already have.
   */
  private async fetchMissingEvents(
    agentId: string,
    conversationId: string,
    sinceSeq: number,
  ): Promise<ReplayedEventLogEntry[]> {
    const gc = this.gatewayConnection;
    if (!gc?.managementBaseUrl || !gc.managementToken) return [];
    const url =
      `${gc.managementBaseUrl}/agents/${encodeURIComponent(agentId)}` +
      `/conversations/${encodeURIComponent(conversationId)}/events?sinceSeq=${sinceSeq}`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${gc.managementToken}` },
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { entries?: ReplayedEventLogEntry[] };
      return body.entries ?? [];
    } catch {
      return [];
    }
  }

  async createConversation(agentId: string): Promise<McConversation> {
    return this.store.create(agentId);
  }

  async listConversations(): Promise<McConversation[]> {
    return this.store.listAll();
  }

  async getMessages(conversationId: string): Promise<McMessage[]> {
    return this.store.getMessages(conversationId);
  }

  async renameConversation(conversationId: string, title: string): Promise<void> {
    return this.store.rename(conversationId, title);
  }

  async deleteConversation(conversationId: string): Promise<void> {
    this.cancel(conversationId);
    return this.store.delete(conversationId);
  }

  async sendMessage(
    conversationId: string,
    text: string,
    images?: { mediaType: string; data: string }[],
  ): Promise<void> {
    const conversation = await this.store.get(conversationId);
    if (!conversation) throw new Error(`Conversation "${conversationId}" not found`);

    if (this.activeStreams.has(conversationId)) {
      throw new Error(`Conversation "${conversationId}" already has an active stream`);
    }

    const userMessage: McMessage = {
      id: randomUUID(),
      role: 'user',
      content: { type: 'user', text, ...(images?.length ? { images } : {}) },
      timestamp: new Date().toISOString(),
    };
    await this.store.appendMessage(conversationId, userMessage);

    if (!this.gatewayConnection) throw new Error('Gateway connection not configured');
    const { channelPort, chatToken } = this.gatewayConnection;
    const url = `ws://localhost:${channelPort}/ws/chat${chatToken ? `?token=${encodeURIComponent(chatToken)}` : ''}`;
    const msgId = randomUUID();
    const agentId = conversation.agentId;
    const ws = new WebSocket(url);
    this.activeStreams.set(conversationId, { ws, msgId });

    const accumulatedEvents: McAgentEvent[] = [];
    // Cursor for the replay endpoint. Advanced on every inbound
    // frame that carries a `seq` — events, done, and error alike.
    let lastSeq = 0;
    // Set to `true` when a terminal frame (`done` or `error`) is
    // received via the WebSocket. If the socket later closes with
    // `terminated === false`, the close handler knows it was an
    // unclean drop and triggers reconciliation.
    let terminated = false;

    // Extracted so both the live message handler and the reconcile
    // path can persist the assistant message in one place. Captures
    // `lastSeq` so startup reconciliation on the next MC launch can
    // resume from exactly where this message left off.
    const persistAssistantMessage = (): void => {
      const assistantMessage: McMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: { type: 'assistant', events: [...accumulatedEvents], lastSeq },
        timestamp: new Date().toISOString(),
      };
      this.store.appendMessage(conversationId, assistantMessage).catch((err) => {
        console.error('[ChatService] Failed to persist assistant message:', err);
      });
    };

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          id: msgId,
          type: 'message',
          agentId,
          channelId: 'mission-control',
          conversationId,
          text,
          ...(images?.length ? { images } : {}),
        }),
      );
    });

    ws.addEventListener('message', (event) => {
      let msg: {
        type: string;
        id: string;
        seq?: number;
        event?: McAgentEvent;
        error?: string;
      };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return; // ignore malformed JSON
      }

      if (msg.id !== msgId) return;

      if (typeof msg.seq === 'number') lastSeq = msg.seq;

      if (msg.type === 'event' && msg.event) {
        accumulatedEvents.push(msg.event);
        this.onEvent(conversationId, msg.event);
      } else if (msg.type === 'done') {
        terminated = true;
        this.activeStreams.delete(conversationId);
        ws.close();
        persistAssistantMessage();
        this.onDone(conversationId);
      } else if (msg.type === 'error') {
        terminated = true;
        this.activeStreams.delete(conversationId);
        ws.close();
        this.onError(conversationId, msg.error ?? 'Unknown error');
      }
    });

    // The 'error' listener used to proactively call onError + delete
    // the active stream, which prevented the close handler from
    // running reconciliation. Now we just log — 'close' fires
    // immediately after and is the single authoritative cleanup
    // point.
    ws.addEventListener('error', () => {
      // no-op: handled in 'close'
    });

    ws.addEventListener('close', () => {
      if (!this.activeStreams.has(conversationId)) return;
      this.activeStreams.delete(conversationId);
      // Clean close — message handler already persisted + fired the
      // terminal callback.
      if (terminated) return;

      // Unclean close: fetch any events the gateway logged after
      // `lastSeq`, merge them into the accumulated stream, and
      // fire the appropriate terminal callback. Reconciliation is
      // best-effort; on any failure we fall back to saving
      // whatever partial state we have, matching the previous
      // behaviour.
      void (async () => {
        try {
          const missing = await this.fetchMissingEvents(agentId, conversationId, lastSeq);
          let replayedTerminal: 'done' | { error: string } | null = null;
          for (const entry of missing) {
            if (entry.payload.type === 'event') {
              accumulatedEvents.push(entry.payload.event);
              this.onEvent(conversationId, entry.payload.event);
            } else if (entry.payload.type === 'done') {
              replayedTerminal = 'done';
            } else if (entry.payload.type === 'error') {
              replayedTerminal = { error: entry.payload.error };
            }
          }

          if (replayedTerminal === 'done') {
            persistAssistantMessage();
            this.onDone(conversationId);
            return;
          }
          if (replayedTerminal && typeof replayedTerminal === 'object') {
            this.onError(conversationId, replayedTerminal.error);
            return;
          }
          // Replay returned no terminal — the stream is still
          // running on the gateway side, but this WebSocket is
          // gone. Save the events we reconciled so the UI shows
          // them, and surface a connection-dropped error so the
          // user knows the response is incomplete.
          if (accumulatedEvents.length > 0) persistAssistantMessage();
          this.onError(conversationId, 'WebSocket connection dropped');
        } catch {
          // Reconciliation itself failed — fall back to the old
          // "save partial events" behaviour.
          if (accumulatedEvents.length > 0) persistAssistantMessage();
          this.onError(conversationId, 'WebSocket connection dropped');
        }
      })();
    });
  }

  cancel(conversationId: string): void {
    const entry = this.activeStreams.get(conversationId);
    if (entry) {
      this.activeStreams.delete(conversationId);
      entry.ws.close();
    }
  }

  answerQuestion(conversationId: string, questionId: string, answer: string): void {
    const entry = this.activeStreams.get(conversationId);
    if (!entry) {
      throw new Error(`No active stream for conversation "${conversationId}"`);
    }
    entry.ws.send(
      JSON.stringify({
        type: 'answer',
        id: entry.msgId,
        questionId,
        answer,
      }),
    );
  }

  /**
   * Iterate every known conversation and, for any whose last
   * persisted message looks incomplete (a trailing user message
   * with no assistant reply, or an assistant reply missing a
   * `response` event), call the gateway's replay endpoint to fetch
   * any events logged since the last seq this MC saw. Merges new
   * events into a fresh assistant message and fires
   * `onEvent`/`onDone`/`onError` so the UI catches up.
   *
   * Called once on MC startup after the gateway connection is
   * ready. Fire-and-forget — never blocks IPC setup on reconcile
   * latency. Fails open: a reconciliation error is logged and the
   * conversation is left in whatever state it was in.
   *
   * No-op when the ChatService has no active gateway connection
   * (e.g. first-run before the setup wizard has completed) or the
   * management endpoint details are missing.
   */
  async reconcileAllConversations(): Promise<void> {
    if (!this.gatewayConnection?.managementBaseUrl || !this.gatewayConnection.managementToken) {
      return;
    }
    const conversations = await this.store.listAll();
    for (const conv of conversations) {
      try {
        await this.reconcileConversation(conv);
      } catch (err) {
        console.error(
          `[ChatService] Reconciliation failed for conversation ${conv.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  private async reconcileConversation(conv: McConversation): Promise<void> {
    const messages = await this.store.getMessages(conv.id);
    if (messages.length === 0) return;

    const last = messages[messages.length - 1];

    // Nothing to reconcile if the last message is a finished
    // assistant reply (assistant role + has a `response` event).
    // A trailing user message, or an assistant message missing a
    // `response` event, means the turn was interrupted.
    const isIncomplete =
      last.role === 'user' ||
      (last.role === 'assistant' &&
        last.content.type === 'assistant' &&
        !last.content.events.some((e) => (e as { type?: string }).type === 'response'));
    if (!isIncomplete) return;

    // Resume cursor: use the highest lastSeq across any assistant
    // messages in this conversation. 0 if there are no assistant
    // messages yet, or if all of them predate the lastSeq field.
    let sinceSeq = 0;
    for (const msg of messages) {
      if (msg.role !== 'assistant' || msg.content.type !== 'assistant') continue;
      const seq = msg.content.lastSeq;
      if (typeof seq === 'number' && seq > sinceSeq) sinceSeq = seq;
    }

    const entries = await this.fetchMissingEvents(conv.agentId, conv.id, sinceSeq);
    if (entries.length === 0) return;

    const newEvents: McAgentEvent[] = [];
    let terminal: 'done' | { error: string } | null = null;
    let highestSeq = sinceSeq;
    for (const entry of entries) {
      if (entry.seq > highestSeq) highestSeq = entry.seq;
      if (entry.payload.type === 'event') {
        newEvents.push(entry.payload.event);
        this.onEvent(conv.id, entry.payload.event);
      } else if (entry.payload.type === 'done') {
        terminal = 'done';
      } else if (entry.payload.type === 'error') {
        terminal = { error: entry.payload.error };
      }
    }

    if (newEvents.length > 0) {
      // Append as a new assistant message rather than trying to
      // merge into a partial one in-place — the ConversationStore
      // is append-only JSONL and an in-place edit would require
      // rewriting the whole file. The UI can treat consecutive
      // assistant messages as a single logical reply.
      const recovered: McMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: { type: 'assistant', events: newEvents, lastSeq: highestSeq },
        timestamp: new Date().toISOString(),
      };
      await this.store.appendMessage(conv.id, recovered);
    }

    if (terminal === 'done') {
      this.onDone(conv.id);
    } else if (terminal && typeof terminal === 'object') {
      this.onError(conv.id, terminal.error);
    }
  }
}
