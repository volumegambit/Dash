import { randomUUID } from 'node:crypto';
import {
  ConversationRepositoryOfflineError,
  GatewayHttpError,
  toCanonicalLegacyContent,
} from '@dash/mc';
import type {
  ConversationRef,
  ConversationStore,
  McConversation,
  McConversationListResult,
  McConversationView,
  McMessage,
} from '@dash/mc';
import type {
  ConversationMessagePage,
  ConversationSummary,
  MobileImage,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
import WebSocket from 'ws';
import type { McAgentEvent } from '../shared/ipc.js';
import type { ConversationController } from './conversation-controller.js';
import type { ResumableChatTransport } from './resumable-chat-transport.js';
import type { SessionStatus } from './session-status-sync.js';

export interface GatewayConnection {
  channelPort?: number;
  chatToken?: string;
  /**
   * WebSocket base URL for a remote/relay gateway (for example
   * "wss://gw.relay.example.com"). When absent, ChatService falls back to the
   * local channel port.
   */
  chatBaseUrl?: string;
  /** Extra hop-by-hop headers, e.g. the relay pairing credential. */
  headers?: Record<string, string>;
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

function legacyView(record: McConversation): McConversationView {
  return {
    id: record.id,
    agentId: record.agentId,
    agentName: record.agentId,
    title: record.title,
    revision: 0,
    status: 'idle',
    activeTurnId: null,
    owningIssueId: record.issueId ?? null,
    projectId: null,
    lastSeq: 0,
    lastMessagePreview: '',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    origin: 'local',
    offline: false,
    readOnly: false,
  };
}

export class ChatService {
  private activeStreams = new Map<string, { ws: WebSocket; msgId: string }>();

  /**
   * Attached by the main process (where the projects client is in scope)
   * to sync the owning task's status from the session lifecycle. Kept as a
   * settable listener rather than a constructor arg so ChatService needs no
   * knowledge of the projects API.
   */
  private sessionStatusListener?: (conversationId: string, status: SessionStatus) => void;

  constructor(
    private store: ConversationStore,
    private onEvent: (conversationId: string, event: McAgentEvent) => void,
    private onDone: (conversationId: string) => void,
    private onError: (conversationId: string, error: string) => void,
    private gatewayConnection?: GatewayConnection,
    private onConversationRenamed?: (conversation: ConversationRef, title: string) => void,
    private conversations?: ConversationController,
    private resumable?: ResumableChatTransport,
  ) {}

  setResumableTransport(transport: ResumableChatTransport | undefined): void {
    if (this.resumable !== transport) this.resumable?.closeAll();
    this.resumable = transport;
  }

  setSessionStatusListener(
    listener: (conversationId: string, status: SessionStatus) => void,
  ): void {
    this.sessionStatusListener = listener;
  }

  /**
   * Forward an agent event to the UI callback, and — when the agent is
   * asking the human a question — surface a 'needs' session status so the
   * owning task can flip to waiting_on_human.
   */
  private emitEvent(conversationId: string, event: McAgentEvent): void {
    this.onEvent(conversationId, event);
    if (event.type === 'question') {
      this.sessionStatusListener?.(conversationId, 'needs');
    }
  }

  /** Fire the turn-complete callback plus a 'done' session status. */
  private emitDone(conversationId: string): void {
    this.onDone(conversationId);
    this.sessionStatusListener?.(conversationId, 'done');
  }

  /** Fire the turn-error callback plus an 'error' session status. */
  private emitError(conversationId: string, error: string): void {
    this.onError(conversationId, error);
    this.sessionStatusListener?.(conversationId, 'error');
  }

  /** The owning task id recorded for a conversation, if any. */
  async getConversationIssueId(ref: ConversationRef): Promise<string | undefined> {
    if (this.conversations) {
      return (await this.conversations.find(ref))?.owningIssueId ?? undefined;
    }
    return (await this.store.get(ref.id))?.issueId;
  }

  setGatewayConnection(connection: GatewayConnection): void {
    this.gatewayConnection = connection;
  }

  private chatWebSocketUrl(gc: GatewayConnection): string {
    const base = gc.chatBaseUrl
      ? gc.chatBaseUrl.replace(/\/+$/, '')
      : `ws://localhost:${gc.channelPort}`;
    return `${base}/ws/chat${gc.chatToken ? `?token=${encodeURIComponent(gc.chatToken)}` : ''}`;
  }

  /** Authenticated JSON fetch against the gateway management API. */
  private async managementFetch(path: string, body: unknown): Promise<Response | null> {
    const gc = this.gatewayConnection;
    if (!gc?.managementBaseUrl || !gc.managementToken) return null;
    return fetch(`${gc.managementBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...gc.headers,
        authorization: `Bearer ${gc.managementToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  }

  /**
   * Background bookkeeping for a conversation's first user message:
   *
   * 1. Ask the gateway for an LLM-generated title (and, when it can tell,
   *    which active project the conversation belongs to).
   * 2. Create a task for the conversation — filed under the inferred
   *    project, or standalone (a "TASK-n") when none was inferred — and
   *    link the conversation to it, mirroring the task→chat dispatch flow.
   * 3. Rename the conversation to `KEY — title` (the same convention
   *    task-dispatch uses) or plain `title` when task creation failed.
   *
   * Fire-and-forget: every step degrades independently — no management
   * connection skips everything; a titling failure still creates the task
   * with the placeholder title; a task failure still applies the title.
   */
  private async titleAndFileTask(conversation: McConversationView, text: string): Promise<void> {
    if (!this.gatewayConnection?.managementBaseUrl) return;
    const ref: ConversationRef = { id: conversation.id, origin: conversation.origin };

    // 1. Title + project inference (best-effort).
    let title = text.slice(0, 60);
    let projectId: string | null = null;
    let titled = false;
    try {
      const res = await this.managementFetch(
        `/agents/${encodeURIComponent(conversation.agentId)}/conversation-title`,
        { text },
      );
      if (res?.ok) {
        const body = (await res.json()) as {
          title?: unknown;
          project?: { id?: unknown } | null;
        };
        if (typeof body.title === 'string' && body.title.trim()) {
          title = body.title.trim();
          titled = true;
        }
        if (body.project && typeof body.project.id === 'string') {
          projectId = body.project.id;
        }
      }
    } catch {
      // Placeholder title; task still gets created below.
    }

    // 2. Create the task and link this conversation to it (best-effort).
    let createdIssue: { id: string; key: string } | null = null;
    try {
      const res = await this.managementFetch('/issues', {
        title,
        project_id: projectId,
        description: `Created automatically from a chat conversation.\n\nFirst message:\n${text.slice(0, 1000)}`,
      });
      if (res?.ok) {
        const issue = (await res.json()) as { id?: unknown; key?: unknown };
        if (typeof issue.id === 'string' && typeof issue.key === 'string') {
          createdIssue = { id: issue.id, key: issue.key };
          await this.managementFetch(`/issues/${encodeURIComponent(issue.id)}/sessions`, {
            session_id: conversation.id,
            agent_id: conversation.agentId,
          }).catch(() => null);
          if (conversation.origin === 'local') {
            // Record ownership so session-status sync can find this task.
            await this.store.setIssueId(conversation.id, issue.id).catch(() => {});
          }
        }
      }
    } catch {
      // No task; the title alone may still apply below.
    }

    // 3. Apply the final conversation name.
    if (conversation.origin === 'gateway') {
      try {
        if (createdIssue) {
          await this.patchGatewayTaskLinkage(ref, title, createdIssue, projectId);
        } else if (titled && this.conversations) {
          const current = await this.conversations.find(ref);
          if (current?.origin === 'gateway' && current.title === 'New Conversation') {
            const updated = await this.conversations.rename(ref, current.revision, title);
            this.onConversationRenamed?.(ref, updated.title);
          }
        }
      } catch {
        // Keep the canonical gateway title/linkage unchanged.
      }
      return;
    }

    const finalTitle = createdIssue ? `${createdIssue.key} — ${title}` : titled ? title : null;
    if (!finalTitle) return;
    try {
      await this.store.rename(conversation.id, finalTitle);
      this.onConversationRenamed?.(ref, finalTitle);
    } catch {
      // Keep the truncated-first-message placeholder.
    }
  }

  private async patchGatewayTaskLinkage(
    ref: ConversationRef,
    suggestedTitle: string,
    issue: { id: string; key: string },
    projectId: string | null,
  ): Promise<void> {
    if (!this.conversations || ref.origin !== 'gateway') return;
    let current = await this.conversations.find(ref);
    if (!current || current.origin !== 'gateway') return;

    for (let attempt = 0; attempt < 2; attempt++) {
      const linkage: Partial<Pick<ConversationSummary, 'title' | 'owningIssueId' | 'projectId'>> = {
        owningIssueId: issue.id,
        ...(projectId === null ? {} : { projectId }),
      };
      if (current.title === 'New Conversation') {
        linkage.title = `${issue.key} — ${suggestedTitle}`;
      }
      try {
        current = await this.conversations.patch(ref, current.revision, linkage);
        this.onConversationRenamed?.(ref, current.title);
        return;
      } catch (error) {
        if (!(error instanceof GatewayHttpError) || error.apiError?.code !== 'revision_conflict') {
          throw error;
        }
        const refreshed = await this.conversations.find(ref);
        if (!refreshed || refreshed.origin !== 'gateway') return;
        current = refreshed;
      }
    }
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
        headers: { ...gc.headers, Authorization: `Bearer ${gc.managementToken}` },
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { entries?: ReplayedEventLogEntry[] };
      return body.entries ?? [];
    } catch {
      return [];
    }
  }

  async createConversation(
    agentId: string,
    requestId: string,
    metadata: Partial<Pick<ConversationSummary, 'title' | 'owningIssueId' | 'projectId'>> = {},
  ): Promise<McConversationView> {
    if (this.conversations) return this.conversations.create(agentId, requestId, metadata);
    const created = await this.store.create(agentId);
    if (metadata.title !== undefined) await this.store.rename(created.id, metadata.title);
    if (typeof metadata.owningIssueId === 'string') {
      await this.store.setIssueId(created.id, metadata.owningIssueId);
    }
    const updated = await this.store.get(created.id);
    if (!updated) throw new Error(`Conversation "${created.id}" not found after create`);
    return legacyView(updated);
  }

  listConversations(cursor?: string): Promise<McConversationListResult> {
    if (this.conversations) return this.conversations.list({ limit: 50, cursor });
    return this.listLegacyConversations();
  }

  async getMessages(ref: ConversationRef, before?: string): Promise<ConversationMessagePage> {
    if (!this.conversations) return this.getLegacyMessagePage(ref.id);
    const [conversation, page] = await Promise.all([
      this.conversations.find(ref),
      this.conversations.messages(ref, { limit: 100, before }),
    ]);
    if (
      ref.origin === 'gateway' &&
      conversation?.status === 'running' &&
      conversation.activeTurnId &&
      this.resumable
    ) {
      await this.resumable.subscribe(conversation, conversation.activeTurnId, page.throughSeq);
    }
    return page;
  }

  async renameConversation(
    ref: ConversationRef,
    revision: number,
    title: string,
  ): Promise<McConversationView> {
    if (this.conversations) return this.conversations.rename(ref, revision, title);
    await this.store.rename(ref.id, title);
    const updated = await this.store.get(ref.id);
    if (!updated) throw new Error(`Conversation "${ref.id}" not found`);
    return legacyView(updated);
  }

  async deleteConversation(ref: ConversationRef, revision: number): Promise<void> {
    if (this.conversations) {
      if (ref.origin === 'local' && this.conversations.authority === 'legacy') {
        this.cancelLegacy(ref.id);
      }
      await this.conversations.delete(ref, revision);
      return;
    }
    await this.cancelLegacy(ref.id);
    return this.store.delete(ref.id);
  }

  async sendMessage(
    ref: ConversationRef,
    turnId: string,
    text: string,
    images?: MobileImage[],
  ): Promise<Extract<MobileWsServerFrame, { type: 'accepted' }> | undefined> {
    if (ref.origin === 'local') {
      if (this.conversations) {
        const conversation = await this.conversations.find(ref);
        if (!conversation) throw new Error(`Conversation "${ref.id}" not found`);
        if (conversation.offline || conversation.readOnly) {
          throw new ConversationRepositoryOfflineError(
            'On this Mac conversations are read-only with this gateway',
          );
        }
      }
      await this.sendLegacyMessage(ref.id, text, images);
      return undefined;
    }
    if (!this.conversations || !this.resumable) {
      throw new Error('Conversation sync unavailable');
    }
    const conversation = await this.conversations.find(ref);
    if (!conversation || conversation.origin !== 'gateway') {
      throw new Error(`Conversation "${ref.id}" not found`);
    }
    if (conversation.offline || conversation.readOnly) {
      throw new ConversationRepositoryOfflineError();
    }
    const accepted = await this.resumable.send(conversation, turnId, text, images);
    if (conversation.title === 'New Conversation') {
      void this.titleAndFileTask(conversation, text);
    }
    return accepted;
  }

  private async listLegacyConversations(): Promise<McConversationListResult> {
    const items = (await this.store.listAll()).map(legacyView);
    return {
      items,
      nextCursor: null,
      authority: 'legacy',
      gatewayOnline: Boolean(this.gatewayConnection),
    };
  }

  private async getLegacyMessagePage(conversationId: string): Promise<ConversationMessagePage> {
    const records = await this.store.getMessages(conversationId);
    return {
      items: records.map((record, index) => ({
        id: record.id,
        conversationId,
        turnId: `legacy:${record.id}`,
        ordinal: index + 1,
        role: record.role,
        status: 'completed',
        content: toCanonicalLegacyContent(record),
        createdAt: record.timestamp,
        updatedAt: record.timestamp,
      })),
      nextCursor: null,
      throughSeq: 0,
    };
  }

  private async sendLegacyMessage(
    conversationId: string,
    text: string,
    images?: MobileImage[],
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
    // The agent is about to work this turn — sync the owning task to
    // in_progress / agent_working. Idempotent when already there.
    this.sessionStatusListener?.(conversationId, 'working');

    // First message of a new conversation: generate a title, create the
    // conversation's task (filed under an inferred project when possible),
    // and link the two — all in the background.
    if (conversation.title === 'New Conversation') {
      void this.titleAndFileTask(legacyView(conversation), text);
    }

    if (!this.gatewayConnection) throw new Error('Gateway connection not configured');
    const url = this.chatWebSocketUrl(this.gatewayConnection);
    const msgId = randomUUID();
    const agentId = conversation.agentId;
    const ws = new WebSocket(url, { headers: this.gatewayConnection.headers });
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
    //
    // Awaits the store write and swallows its own errors so callers
    // can `await` it before firing the terminal callback — that makes
    // `onDone`/`onError` a reliable "message persisted" signal rather
    // than racing the fire-and-forget write. (The previous
    // fire-and-forget version let the write land after a consumer had
    // already torn down the conversation directory.)
    const persistAssistantMessage = async (): Promise<void> => {
      const assistantMessage: McMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: { type: 'assistant', events: [...accumulatedEvents], lastSeq },
        timestamp: new Date().toISOString(),
      };
      try {
        await this.store.appendMessage(conversationId, assistantMessage);
      } catch (err) {
        console.error('[ChatService] Failed to persist assistant message:', err);
      }
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
        this.emitEvent(conversationId, msg.event);
      } else if (msg.type === 'done') {
        terminated = true;
        this.activeStreams.delete(conversationId);
        ws.close();
        // Persist first, then fire onDone — see persistAssistantMessage.
        void persistAssistantMessage().then(() => this.emitDone(conversationId));
      } else if (msg.type === 'error') {
        terminated = true;
        this.activeStreams.delete(conversationId);
        ws.close();
        this.emitError(conversationId, msg.error ?? 'Unknown error');
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
              this.emitEvent(conversationId, entry.payload.event);
            } else if (entry.payload.type === 'done') {
              replayedTerminal = 'done';
            } else if (entry.payload.type === 'error') {
              replayedTerminal = { error: entry.payload.error };
            }
          }

          if (replayedTerminal === 'done') {
            await persistAssistantMessage();
            this.emitDone(conversationId);
            return;
          }
          if (replayedTerminal && typeof replayedTerminal === 'object') {
            this.emitError(conversationId, replayedTerminal.error);
            return;
          }
          // Replay returned no terminal — the stream is still
          // running on the gateway side, but this WebSocket is
          // gone. Save the events we reconciled so the UI shows
          // them, and surface a connection-dropped error so the
          // user knows the response is incomplete.
          if (accumulatedEvents.length > 0) await persistAssistantMessage();
          this.emitError(conversationId, 'WebSocket connection dropped');
        } catch {
          // Reconciliation itself failed — fall back to the old
          // "save partial events" behaviour.
          if (accumulatedEvents.length > 0) await persistAssistantMessage();
          this.emitError(conversationId, 'WebSocket connection dropped');
        }
      })();
    });
  }

  async cancel(ref: ConversationRef, turnId?: string): Promise<void> {
    if (ref.origin === 'local') {
      this.cancelLegacy(ref.id);
      return;
    }
    if (!this.conversations || !this.resumable || !turnId) {
      throw new Error('Conversation sync unavailable for gateway cancel');
    }
    const conversation = await this.conversations.find(ref);
    if (!conversation || conversation.origin !== 'gateway') {
      throw new Error(`Conversation "${ref.id}" not found`);
    }
    if (conversation.activeTurnId !== turnId) {
      throw new Error(`Conversation "${ref.id}" does not have active turn "${turnId}"`);
    }
    this.resumable.cancel(ref.id, turnId);
  }

  private cancelLegacy(conversationId: string): void {
    const entry = this.activeStreams.get(conversationId);
    if (entry) {
      this.activeStreams.delete(conversationId);
      // Tell the gateway this is an explicit user cancel BEFORE closing (a
      // bare close reads as a network drop).
      try {
        if (entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send(JSON.stringify({ type: 'cancel', id: entry.msgId }));
        }
      } catch {
        // Closing anyway.
      }
      entry.ws.close();
    }
    // ALWAYS also cancel the conversation's live swarm turn over HTTP —
    // swarm workers outlive the orchestrator's WS stream by design (the
    // stream may have timed out or finished while workers still run), so
    // the frame above cannot be the only cancel vehicle. Idempotent
    // server-side; fire-and-forget here.
    void this.cancelSwarmTurn(conversationId);
  }

  /** Best-effort HTTP cancel of the conversation's live swarm turn. */
  private async cancelSwarmTurn(conversationId: string): Promise<void> {
    try {
      const conversation = await this.store.get(conversationId);
      if (!conversation) return;
      await this.managementFetch(
        `/agents/${encodeURIComponent(conversation.agentId)}/conversations/${encodeURIComponent(conversationId)}/swarm/cancel`,
        {},
      );
    } catch {
      // No management connection or transient failure — nothing to clean up.
    }
  }

  async answerQuestion(
    ref: ConversationRef,
    turnId: string | undefined,
    questionId: string,
    answer: string,
  ): Promise<void> {
    if (ref.origin === 'gateway') {
      if (!this.conversations || !this.resumable || !turnId) {
        throw new Error('Conversation sync unavailable for gateway answer');
      }
      const conversation = await this.conversations.find(ref);
      if (!conversation || conversation.origin !== 'gateway') {
        throw new Error(`Conversation "${ref.id}" not found`);
      }
      if (conversation.activeTurnId !== turnId) {
        throw new Error(`Conversation "${ref.id}" does not have active turn "${turnId}"`);
      }
      this.resumable.answer(ref.id, turnId, questionId, answer);
      return;
    }
    this.answerLegacyQuestion(ref.id, questionId, answer);
  }

  private answerLegacyQuestion(conversationId: string, questionId: string, answer: string): void {
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
    return this.reconcileLegacyConversations();
  }

  private async reconcileLegacyConversations(): Promise<void> {
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
        this.emitEvent(conv.id, entry.payload.event);
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
      this.emitDone(conv.id);
    } else if (terminal && typeof terminal === 'object') {
      this.emitError(conv.id, terminal.error);
    }
  }
}
