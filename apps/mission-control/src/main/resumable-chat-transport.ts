import {
  type ConversationRef,
  ConversationRepositoryOfflineError,
  GatewayHttpError,
} from '@dash/mc';
import type {
  ConversationSummary,
  MobileApiErrorCode,
  MobileImage,
  MobileWsClientFrame,
  MobileWsServerFrame,
  ReplayEntry,
} from '@dash/mobile-contract';
import WebSocket from 'ws';

export interface ChatSocketEvent {
  data?: unknown;
  code?: number;
  reason?: string;
}

export interface ChatSocket {
  readonly readyState: number;
  addEventListener(name: string, listener: (event: ChatSocketEvent) => void): void;
  send(data: string): void;
  close(): void;
}

export class ResumableChatTransportError extends Error {
  constructor(
    readonly kind: 'server' | 'repair_required' | 'rate_limited' | 'update_required',
    message: string,
    readonly code?: string,
    readonly retryable?: boolean,
    readonly activeTurnId?: string,
    readonly retryAfterMs?: number,
    readonly closeCode?: number,
  ) {
    super(message);
    this.name = 'ResumableChatTransportError';
  }
}

export type ChatSocketFactory = (
  url: string,
  options: { headers?: Record<string, string> },
) => ChatSocket;

export interface ResumableChatConnection {
  url: string;
  headers?: Record<string, string>;
}

export interface ResumableChatTransportOptions {
  connection: ResumableChatConnection;
  channelId: string;
  replay(ref: ConversationRef, agentId: string, sinceSeq: number): Promise<ReplayEntry[]>;
  onFrame(frame: MobileWsServerFrame): void;
  onConnectionError(conversationId: string, error: ResumableChatTransportError): void;
  onProtocolError(conversationId: string, message: string): void;
  socketFactory?: ChatSocketFactory;
}

type AcceptedFrame = Extract<MobileWsServerFrame, { type: 'accepted' }>;

interface TurnState {
  conversation: ConversationSummary;
  turnId: string;
  lastSeq: number;
  terminal: boolean;
  accepted: boolean;
  resuming: boolean;
  socket: ChatSocket | null;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  delivery: Promise<void>;
  originalMessage: MobileWsClientFrame | null;
  acceptance: Promise<AcceptedFrame> | null;
  resolveAccepted?: (frame: AcceptedFrame) => void;
  rejectAccepted?: (error: Error) => void;
  cancelRequested: boolean;
  queuedFrames: MobileWsClientFrame[];
}

const API_ERROR_CODES = new Set<MobileApiErrorCode>([
  'unauthorized',
  'not_found',
  'validation_failed',
  'revision_conflict',
  'conversation_busy',
  'rate_limited',
  'gateway_offline',
  'capability_required',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isInteger(value) && value > 0;
}

function isNonblankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalNonblankString(value: unknown): boolean {
  return value === undefined || isNonblankString(value);
}

function invalidFrame(): never {
  throw new ResumableChatTransportError(
    'update_required',
    'Update Dash: the gateway sent an unsupported chat frame',
  );
}

export function parseCapableServerFrame(value: unknown): MobileWsServerFrame {
  if (!isRecord(value) || !isNonblankString(value.type) || !isNonblankString(value.id)) {
    return invalidFrame();
  }

  switch (value.type) {
    case 'accepted':
      if (
        !isNonblankString(value.conversationId) ||
        !isNonblankString(value.userMessageId) ||
        !isNonblankString(value.assistantMessageId) ||
        !isPositiveInteger(value.revision) ||
        !isPositiveInteger(value.seq)
      ) {
        return invalidFrame();
      }
      break;
    case 'event':
      if (
        !isNonblankString(value.conversationId) ||
        !isPositiveInteger(value.seq) ||
        !isRecord(value.event) ||
        !isNonblankString(value.event.type)
      ) {
        return invalidFrame();
      }
      break;
    case 'done':
      if (
        !isNonblankString(value.conversationId) ||
        !isPositiveInteger(value.seq) ||
        (value.outcome !== 'completed' && value.outcome !== 'cancelled')
      ) {
        return invalidFrame();
      }
      break;
    case 'error': {
      const hasConversation = Object.hasOwn(value, 'conversationId');
      const hasSequence = Object.hasOwn(value, 'seq');
      if (
        !isNonblankString(value.error) ||
        (hasSequence && !hasConversation) ||
        (hasConversation && !isNonblankString(value.conversationId)) ||
        (hasSequence && !isPositiveInteger(value.seq)) ||
        (value.code !== undefined &&
          (typeof value.code !== 'string' ||
            !API_ERROR_CODES.has(value.code as MobileApiErrorCode))) ||
        (value.retryable !== undefined && typeof value.retryable !== 'boolean') ||
        !isOptionalNonblankString(value.activeTurnId)
      ) {
        return invalidFrame();
      }
      break;
    }
    default:
      return invalidFrame();
  }

  return value as unknown as MobileWsServerFrame;
}

function sequence(frame: MobileWsServerFrame): number | null {
  return 'seq' in frame && typeof frame.seq === 'number' ? frame.seq : null;
}

function replayFrame(entry: ReplayEntry): MobileWsServerFrame {
  const base = {
    id: entry.msgId,
    conversationId: entry.conversationId,
    seq: entry.seq,
  };
  switch (entry.payload.type) {
    case 'accepted':
      return {
        type: 'accepted',
        ...base,
        userMessageId: entry.payload.userMessageId,
        assistantMessageId: entry.payload.assistantMessageId,
        revision: entry.payload.revision,
      };
    case 'event':
      return { ...base, type: 'event', event: entry.payload.event };
    case 'done':
      return { ...base, type: 'done', outcome: entry.payload.outcome ?? 'completed' };
    case 'error':
      return {
        ...base,
        type: 'error',
        error: entry.payload.error,
        code: entry.payload.code,
        retryable: entry.payload.retryable,
      };
  }
}

function reconnectDelay(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** attempt);
}

function retryAfterMs(reason: string): number | undefined {
  try {
    const parsed = JSON.parse(reason) as unknown;
    if (isRecord(parsed)) {
      if (typeof parsed.retryAfterMs === 'number' && parsed.retryAfterMs >= 0) {
        return parsed.retryAfterMs;
      }
      if (typeof parsed.retryAfterSeconds === 'number' && parsed.retryAfterSeconds >= 0) {
        return parsed.retryAfterSeconds * 1_000;
      }
    }
  } catch {
    // Some gateways use a plain-text close reason.
  }
  const milliseconds = /retryAfterMs\D+(\d+)/i.exec(reason)?.[1];
  if (milliseconds) return Number(milliseconds);
  const seconds = /retryAfterSeconds\D+(\d+)/i.exec(reason)?.[1];
  if (seconds) return Number(seconds) * 1_000;
  return undefined;
}

function retryAfterFromHttpError(error: GatewayHttpError): number | undefined {
  const details = error.apiError?.details;
  if (!isRecord(details)) return undefined;
  if (typeof details.retryAfterMs === 'number' && details.retryAfterMs >= 0) {
    return details.retryAfterMs;
  }
  if (typeof details.retryAfterSeconds === 'number' && details.retryAfterSeconds >= 0) {
    return details.retryAfterSeconds * 1_000;
  }
  return undefined;
}

function isReplayOfflineFailure(error: unknown): boolean {
  if (error instanceof ConversationRepositoryOfflineError) return true;
  if (error instanceof GatewayHttpError) {
    return error.status >= 500 || error.apiError?.code === 'gateway_offline';
  }
  if (error instanceof TypeError) return true;
  return error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name);
}

function classifyReplayFailure(error: unknown): ResumableChatTransportError | null {
  if (isReplayOfflineFailure(error)) return null;
  if (error instanceof ResumableChatTransportError) return error;
  if (error instanceof GatewayHttpError) {
    const code = error.apiError?.code;
    if (error.status === 401 || code === 'unauthorized') {
      return new ResumableChatTransportError(
        'repair_required',
        'Gateway authorization failed. Reconnect this gateway to continue.',
        code,
        false,
      );
    }
    if (error.status === 429 || code === 'rate_limited') {
      return new ResumableChatTransportError(
        'rate_limited',
        error.apiError?.error ?? 'Gateway rate limit reached. Retry when the countdown finishes.',
        code,
        error.apiError?.retryable ?? true,
        undefined,
        retryAfterFromHttpError(error),
      );
    }
    if (error.status === 426 || code === 'capability_required') {
      return new ResumableChatTransportError(
        'update_required',
        `Update Dash: ${error.apiError?.error ?? 'the gateway requires a newer client'}`,
        code,
        error.apiError?.retryable ?? false,
      );
    }
  }
  return new ResumableChatTransportError(
    'update_required',
    `Update Dash: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const defaultSocketFactory: ChatSocketFactory = (url, options) =>
  new WebSocket(url, { headers: options.headers }) as unknown as ChatSocket;

export class ResumableChatTransport {
  private readonly turns = new Map<string, TurnState>();
  private readonly socketFactory: ChatSocketFactory;
  private closed = false;

  constructor(private readonly options: ResumableChatTransportOptions) {
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
  }

  send(
    conversation: ConversationSummary,
    turnId: string,
    text: string,
    images?: MobileImage[],
  ): Promise<AcceptedFrame> {
    this.assertOpen();
    const current = this.turns.get(conversation.id);
    if (current) {
      if (current.turnId !== turnId) {
        throw new Error(`Conversation "${conversation.id}" already has an active turn`);
      }
      if (!current.accepted && current.originalMessage && current.socket?.readyState === 1) {
        this.write(current.socket, current.originalMessage);
      }
      if (!current.acceptance) {
        throw new Error(`Conversation "${conversation.id}" already has an accepted active turn`);
      }
      return current.acceptance;
    }

    const message = {
      type: 'message',
      id: turnId,
      agentId: conversation.agentId,
      channelId: this.options.channelId,
      conversationId: conversation.id,
      text,
      ...(images?.length ? { images } : {}),
      streamingBehavior: 'followUp',
      resumable: true,
    } satisfies MobileWsClientFrame;
    let resolveAccepted: ((frame: AcceptedFrame) => void) | undefined;
    let rejectAccepted: ((error: Error) => void) | undefined;
    const acceptance = new Promise<AcceptedFrame>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const state: TurnState = {
      conversation,
      turnId,
      lastSeq: conversation.lastSeq,
      terminal: false,
      accepted: false,
      resuming: false,
      socket: null,
      reconnectAttempt: 0,
      reconnectTimer: null,
      delivery: Promise.resolve(),
      originalMessage: message,
      acceptance,
      resolveAccepted,
      rejectAccepted,
      cancelRequested: false,
      queuedFrames: [],
    };
    this.turns.set(conversation.id, state);
    this.connect(state);
    return acceptance;
  }

  async subscribe(
    conversation: ConversationSummary,
    turnId: string,
    sinceSeq = conversation.lastSeq,
  ): Promise<void> {
    this.assertOpen();
    const current = this.turns.get(conversation.id);
    if (current) {
      if (current.turnId !== turnId) {
        throw new Error(`Conversation "${conversation.id}" already has an active turn`);
      }
      return;
    }
    const state: TurnState = {
      conversation,
      turnId,
      lastSeq: sinceSeq,
      terminal: false,
      accepted: true,
      resuming: false,
      socket: null,
      reconnectAttempt: 0,
      reconnectTimer: null,
      delivery: Promise.resolve(),
      originalMessage: null,
      acceptance: null,
      cancelRequested: false,
      queuedFrames: [],
    };
    this.turns.set(conversation.id, state);
    this.connect(state);
  }

  cancel(conversationId: string, turnId: string): void {
    const state = this.turns.get(conversationId);
    if (!state || state.turnId !== turnId || state.terminal) return;
    state.cancelRequested = true;
    this.sendWhenOpen(state, { type: 'cancel', id: turnId } satisfies MobileWsClientFrame);
  }

  answer(conversationId: string, turnId: string, questionId: string, answer: string): void {
    const state = this.turns.get(conversationId);
    if (!state || state.turnId !== turnId || state.terminal) {
      throw new Error(`No active turn "${turnId}" for conversation "${conversationId}"`);
    }
    this.sendWhenOpen(state, {
      type: 'answer',
      id: turnId,
      questionId,
      answer,
    } satisfies MobileWsClientFrame);
  }

  closeAll(): void {
    this.closed = true;
    for (const state of [...this.turns.values()]) {
      state.terminal = true;
      state.rejectAccepted?.(new Error('Chat transport closed'));
      state.resolveAccepted = undefined;
      state.rejectAccepted = undefined;
      this.clearReconnect(state);
      this.turns.delete(state.conversation.id);
      const socket = state.socket;
      state.socket = null;
      socket?.close();
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Chat transport closed');
  }

  private connect(state: TurnState): void {
    if (this.closed || state.terminal || this.turns.get(state.conversation.id) !== state) return;
    let socket: ChatSocket;
    try {
      socket = this.socketFactory(this.options.connection.url, {
        headers: this.options.connection.headers,
      });
    } catch (error) {
      this.fail(state, error);
      return;
    }
    state.socket = socket;
    socket.addEventListener('open', () => {
      if (state.socket !== socket || state.terminal || this.closed) return;
      state.reconnectAttempt = 0;
      if (state.accepted) {
        state.resuming = true;
        this.write(socket, {
          type: 'resume',
          id: state.turnId,
          agentId: state.conversation.agentId,
          conversationId: state.conversation.id,
          sinceSeq: state.lastSeq,
        });
      } else if (state.originalMessage) {
        this.write(socket, state.originalMessage);
      }
      if (state.cancelRequested) {
        this.write(socket, { type: 'cancel', id: state.turnId });
      }
      for (const frame of state.queuedFrames.splice(0)) this.write(socket, frame);
    });
    socket.addEventListener('message', (event) => {
      if (state.socket !== socket || state.terminal || this.closed) return;
      state.delivery = state.delivery
        .then(async () => {
          if (state.terminal || this.turns.get(state.conversation.id) !== state) return;
          let value: unknown;
          try {
            const data = typeof event.data === 'string' ? event.data : String(event.data);
            value = JSON.parse(data) as unknown;
          } catch {
            return invalidFrame();
          }
          await this.receive(state, parseCapableServerFrame(value));
        })
        .catch((error) => this.fail(state, error));
    });
    socket.addEventListener('close', (event) => {
      if (state.socket !== socket) return;
      state.socket = null;
      if (state.terminal || this.closed) return;
      const closeCode = event.code ?? 1006;
      const reason = event.reason ?? '';
      if (closeCode === 4001 || closeCode === 4401) {
        this.fail(
          state,
          new ResumableChatTransportError(
            'repair_required',
            'Gateway authorization failed. Reconnect this gateway to continue.',
            undefined,
            false,
            undefined,
            undefined,
            closeCode,
          ),
        );
        return;
      }
      if (closeCode === 4429) {
        this.fail(
          state,
          new ResumableChatTransportError(
            'rate_limited',
            'Gateway rate limit reached. Retry when the countdown finishes.',
            'rate_limited',
            true,
            undefined,
            retryAfterMs(reason),
            closeCode,
          ),
        );
        return;
      }
      this.scheduleReconnect(state);
    });
  }

  private async receive(state: TurnState, frame: MobileWsServerFrame): Promise<void> {
    const replayingForeignTurn = state.resuming && frame.id !== state.turnId;
    if (replayingForeignTurn) this.assertConversationOwnership(state, frame);
    else this.assertOwnership(state, frame);
    if (frame.id === state.turnId) state.resuming = false;
    const seq = sequence(frame);
    if (seq === null) {
      if (frame.type === 'error') {
        const error = new ResumableChatTransportError(
          'server',
          frame.error,
          frame.code,
          frame.retryable,
          frame.activeTurnId,
        );
        state.rejectAccepted?.(error);
        this.options.onFrame(frame);
        if (state.accepted) this.options.onConnectionError(state.conversation.id, error);
        if (state.accepted && frame.conversationId === undefined) return;
        state.terminal = true;
        this.finish(state.conversation.id);
        return;
      }
      return invalidFrame();
    }
    if (seq <= state.lastSeq) return;
    if (seq > state.lastSeq + 1) {
      let replayed: ReplayEntry[];
      try {
        replayed = await this.options.replay(
          { id: state.conversation.id, origin: 'gateway' },
          state.conversation.agentId,
          state.lastSeq,
        );
      } catch (error) {
        const classified = classifyReplayFailure(error);
        if (classified) throw classified;
        this.restart(state);
        return;
      }
      const replayFrames = replayed
        .map((entry) => this.parseReplayEntry(state, entry))
        .sort((a, b) => (sequence(a) as number) - (sequence(b) as number));
      for (const missing of replayFrames) {
        if (missing.id === state.turnId) {
          await this.deliverIfNext(state, missing);
        } else {
          this.advanceReplayCursor(state, missing);
        }
        if (state.terminal) return;
      }
      if (seq > state.lastSeq + 1) {
        this.restart(state);
        return;
      }
    }
    if (replayingForeignTurn) {
      this.advanceReplayCursor(state, frame);
      return;
    }
    await this.deliverIfNext(state, frame);
  }

  private async deliverIfNext(state: TurnState, frame: MobileWsServerFrame): Promise<void> {
    const seq = sequence(frame);
    if (seq === null || seq <= state.lastSeq) return;
    if (seq !== state.lastSeq + 1) return;
    state.lastSeq = seq;
    if (frame.type === 'accepted') {
      state.accepted = true;
      state.resolveAccepted?.(frame);
      state.resolveAccepted = undefined;
      state.rejectAccepted = undefined;
    }
    if (frame.type === 'done' || frame.type === 'error') {
      state.terminal = true;
    }
    this.options.onFrame(frame);
    if (state.terminal) this.finish(state.conversation.id);
  }

  private advanceReplayCursor(state: TurnState, frame: MobileWsServerFrame): void {
    const seq = sequence(frame);
    if (seq === null || seq <= state.lastSeq || seq !== state.lastSeq + 1) return;
    state.lastSeq = seq;
  }

  private assertOwnership(state: TurnState, frame: MobileWsServerFrame): void {
    if (frame.id !== state.turnId) invalidFrame();
    if (
      'conversationId' in frame &&
      frame.conversationId !== undefined &&
      frame.conversationId !== state.conversation.id
    ) {
      invalidFrame();
    }
  }

  private assertConversationOwnership(state: TurnState, frame: MobileWsServerFrame): void {
    if (!('conversationId' in frame) || frame.conversationId !== state.conversation.id) {
      invalidFrame();
    }
  }

  private parseReplayEntry(state: TurnState, value: unknown): MobileWsServerFrame {
    if (
      !isRecord(value) ||
      !isPositiveInteger(value.seq) ||
      !isNonblankString(value.msgId) ||
      !isNonblankString(value.agentId) ||
      !isNonblankString(value.conversationId) ||
      !isNonblankString(value.timestamp) ||
      !isRecord(value.payload) ||
      value.agentId !== state.conversation.agentId ||
      value.conversationId !== state.conversation.id
    ) {
      return invalidFrame();
    }
    return parseCapableServerFrame(replayFrame(value as unknown as ReplayEntry));
  }

  private sendWhenOpen(state: TurnState, frame: MobileWsClientFrame): void {
    if (state.socket?.readyState === 1) {
      this.write(state.socket, frame);
      return;
    }
    if (frame.type !== 'cancel') state.queuedFrames.push(frame);
  }

  private write(socket: ChatSocket, frame: MobileWsClientFrame): void {
    socket.send(JSON.stringify(frame));
  }

  private scheduleReconnect(state: TurnState): void {
    if (state.reconnectTimer || state.terminal || this.closed) return;
    const delay = reconnectDelay(state.reconnectAttempt);
    state.reconnectAttempt += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      this.connect(state);
    }, delay);
  }

  private restart(state: TurnState): void {
    if (state.terminal || this.closed || this.turns.get(state.conversation.id) !== state) return;
    const socket = state.socket;
    state.socket = null;
    socket?.close();
    this.scheduleReconnect(state);
  }

  private clearReconnect(state: TurnState): void {
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  private fail(state: TurnState, cause: unknown): void {
    if (state.terminal || this.turns.get(state.conversation.id) !== state) return;
    const error =
      cause instanceof ResumableChatTransportError
        ? cause
        : new ResumableChatTransportError(
            'update_required',
            `Update Dash: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
    state.rejectAccepted?.(error);
    state.terminal = true;
    this.options.onConnectionError(state.conversation.id, error);
    this.finish(state.conversation.id);
  }

  private finish(conversationId: string): void {
    const state = this.turns.get(conversationId);
    if (!state) return;
    this.turns.delete(conversationId);
    this.clearReconnect(state);
    state.resolveAccepted = undefined;
    state.rejectAccepted = undefined;
    state.queuedFrames = [];
    const socket = state.socket;
    state.socket = null;
    socket?.close();
  }
}
