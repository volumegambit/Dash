import {
  CHAT_INPUT_QUEUE_CAPABILITY,
  type ConversationSummary,
  MOBILE_V2_CONTRACT_VERSION,
  type MobileAgentEvent,
  type MobileApiError,
  type MobileApiErrorCode,
  type MobileClientLocation,
  type MobileImage,
  type MobileV2PendingInput,
  type MobileV2SequencedFrame,
  type MobileV2WsClientFrame,
  type MobileV2WsServerFrame,
  isMobileV2LegacyRunId,
} from '@dash/mobile-contract-v2';
import WebSocket from 'ws';
import {
  type ChatSocket,
  type ChatSocketFactory,
  type ResumableChatConnection,
  ResumableChatTransportError,
  parseChatRetryAfterMs,
} from './resumable-chat-transport.js';

export interface EnqueueInputCommand {
  commandId: string;
  inputId: string;
  behavior: 'steer' | 'followUp';
  expectedActiveTurnId?: string;
  text: string;
  images?: MobileImage[];
}

export interface EditFollowUpCommand {
  commandId: string;
  inputId: string;
  expectedRevision: number;
  text: string;
  images?: MobileImage[];
}

export class ConversationChatCommandError extends Error {
  readonly name = 'ConversationChatCommandError';

  constructor(
    readonly commandId: string,
    readonly apiError: MobileApiError,
  ) {
    super(apiError.error);
  }
}

export interface ConversationChatTransportOptions {
  connection: ResumableChatConnection;
  channelId: string;
  onFrame(frame: MobileV2SequencedFrame): void;
  onConnectionError(conversationId: string, error: ResumableChatTransportError): void;
  onCommandError(conversationId: string, error: ConversationChatCommandError): void;
  socketFactory?: ChatSocketFactory;
}

type AcceptedFrame = Extract<MobileV2SequencedFrame, { type: 'accepted' }>;
type InputAcceptedFrame = Extract<MobileV2SequencedFrame, { type: 'input_accepted' }>;
type InputUpdatedFrame = Extract<MobileV2SequencedFrame, { type: 'input_updated' }>;
type InputRemovedFrame = Extract<MobileV2SequencedFrame, { type: 'input_removed' }>;
type QueueResumedFrame = Extract<MobileV2SequencedFrame, { type: 'queue_resumed' }>;
type QueueCommandFrame = Extract<
  MobileV2WsClientFrame,
  { type: 'enqueue_input' | 'edit_follow_up' | 'remove_follow_up' | 'resume_follow_ups' }
>;
type PromiseCommandFrame = Extract<MobileV2WsClientFrame, { type: 'message' }> | QueueCommandFrame;
type AnswerFrame = Extract<MobileV2WsClientFrame, { type: 'answer' }>;

interface Deferred<T> {
  promise: Promise<T>;
  settled: boolean;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface PendingCommand {
  kind: 'send' | 'queue';
  expectedType: MobileV2SequencedFrame['type'];
  frame: PromiseCommandFrame;
  deferred: Deferred<MobileV2SequencedFrame>;
}

interface ConversationState {
  conversation: ConversationSummary;
  lastV2Seq: number;
  socket: ChatSocket | null;
  generation: number;
  negotiated: boolean;
  subscribed: boolean;
  pendingSubscriptionId: string | null;
  opening: Deferred<void> | null;
  pendingCommands: Map<string, PendingCommand>;
  stickyCancels: Set<string>;
  unsentAnswers: AnswerFrame[];
  legacyCorrelations: Set<string>;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  terminal: boolean;
}

type RecordValue = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
const INPUT_KINDS = new Set(['steer', 'follow_up']);
const INPUT_STATES = new Set(['queued', 'delivering', 'delivered', 'removed', 'failed']);
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const PROTOCOL_CLOSE_REASONS = new Set([
  'unsupported_version',
  'unexpected_hello',
  'hello_required',
  'invalid_frame',
]);

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {};
  let rejectPromise: (error: Error) => void = () => {};
  const result: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    settled: false,
    resolve(value) {
      if (result.settled) return;
      result.settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (result.settled) return;
      result.settled = true;
      rejectPromise(error);
    },
  };
  return result;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasExactKeys(
  record: RecordValue,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => hasOwn(record, key)) &&
    Object.keys(record).every((key) => allowed.has(key))
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isApiErrorCode(value: unknown): value is MobileApiErrorCode {
  return typeof value === 'string' && API_ERROR_CODES.has(value as MobileApiErrorCode);
}

function isRfc3339(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isMobileImage(value: unknown): value is MobileImage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['mediaType', 'data']) &&
    typeof value.mediaType === 'string' &&
    IMAGE_MEDIA_TYPES.has(value.mediaType) &&
    isNonemptyString(value.data)
  );
}

function isImages(value: unknown): value is MobileImage[] {
  return Array.isArray(value) && value.length <= 4 && value.every(isMobileImage);
}

function isClientLocation(value: unknown): value is MobileClientLocation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['timezone', 'utcOffsetMinutes', 'locale'], ['region', 'precise']) ||
    !isNonemptyString(value.timezone) ||
    value.timezone.length > 200 ||
    !Number.isSafeInteger(value.utcOffsetMinutes) ||
    (value.utcOffsetMinutes as number) < -840 ||
    (value.utcOffsetMinutes as number) > 840 ||
    !isNonemptyString(value.locale) ||
    value.locale.length > 200 ||
    (hasOwn(value, 'region') && (typeof value.region !== 'string' || value.region.length !== 2))
  ) {
    return false;
  }
  if (!hasOwn(value, 'precise')) return true;
  const precise = value.precise;
  return (
    isRecord(precise) &&
    hasExactKeys(precise, ['latitude', 'longitude', 'accuracyMeters', 'capturedAt'], ['place']) &&
    typeof precise.latitude === 'number' &&
    Number.isFinite(precise.latitude) &&
    precise.latitude >= -90 &&
    precise.latitude <= 90 &&
    typeof precise.longitude === 'number' &&
    Number.isFinite(precise.longitude) &&
    precise.longitude >= -180 &&
    precise.longitude <= 180 &&
    isNonnegativeSafeInteger(precise.accuracyMeters) &&
    isRfc3339(precise.capturedAt) &&
    (!hasOwn(precise, 'place') || (isNonemptyString(precise.place) && precise.place.length <= 200))
  );
}

function isMobileAgentEvent(value: unknown): value is MobileAgentEvent {
  return isRecord(value) && isNonemptyString(value.type);
}

function isPendingInput(value: unknown): value is MobileV2PendingInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['inputId', 'kind', 'text', 'state', 'revision', 'enqueueOrder', 'createdAt', 'updatedAt'],
      [
        'targetTurnId',
        'images',
        'runId',
        'segmentTurnId',
        'userMessageId',
        'assistantMessageId',
        'failureCode',
        'failureMessage',
        'deliveredAt',
      ],
    ) ||
    !isUuid(value.inputId) ||
    typeof value.kind !== 'string' ||
    !INPUT_KINDS.has(value.kind) ||
    typeof value.text !== 'string' ||
    typeof value.state !== 'string' ||
    !INPUT_STATES.has(value.state) ||
    !isNonnegativeSafeInteger(value.revision) ||
    !isNonnegativeSafeInteger(value.enqueueOrder) ||
    !isRfc3339(value.createdAt) ||
    !isRfc3339(value.updatedAt)
  ) {
    return false;
  }
  if (hasOwn(value, 'targetTurnId') && !isMobileV2LegacyRunId(value.targetTurnId)) return false;
  if (hasOwn(value, 'images') && !isImages(value.images)) return false;
  if (hasOwn(value, 'runId') && !isMobileV2LegacyRunId(value.runId)) return false;
  for (const key of ['segmentTurnId', 'userMessageId', 'assistantMessageId'] as const) {
    if (hasOwn(value, key) && !isUuid(value[key])) return false;
  }
  if (hasOwn(value, 'failureCode') && !isApiErrorCode(value.failureCode)) return false;
  if (hasOwn(value, 'failureMessage') && !isNonemptyString(value.failureMessage)) return false;
  if (hasOwn(value, 'deliveredAt') && !isRfc3339(value.deliveredAt)) return false;
  return true;
}

function protocolError(reason = 'invalid_frame', closeCode?: number): ResumableChatTransportError {
  return new ResumableChatTransportError(
    'update_required',
    `Update Dash: gateway chat protocol error (${reason})`,
    reason,
    false,
    undefined,
    undefined,
    closeCode,
  );
}

function validateHelloAck(record: RecordValue): boolean {
  return (
    hasExactKeys(record, ['type', 'contractVersion', 'capabilities']) &&
    record.contractVersion === MOBILE_V2_CONTRACT_VERSION &&
    Array.isArray(record.capabilities) &&
    record.capabilities.every(isNonemptyString) &&
    new Set(record.capabilities).size === record.capabilities.length &&
    record.capabilities.includes(CHAT_INPUT_QUEUE_CAPABILITY)
  );
}

function validateConversationSubscribed(record: RecordValue): boolean {
  return (
    hasExactKeys(record, ['type', 'id', 'conversationId', 'v2ThroughSeq']) &&
    isUuid(record.id) &&
    isUuid(record.conversationId) &&
    isNonnegativeSafeInteger(record.v2ThroughSeq)
  );
}

function validateCommandRejected(record: RecordValue): boolean {
  return (
    hasExactKeys(
      record,
      ['type', 'id', 'code', 'error', 'retryable'],
      ['conversationId', 'details'],
    ) &&
    isMobileV2LegacyRunId(record.id) &&
    (!hasOwn(record, 'conversationId') || isUuid(record.conversationId)) &&
    isApiErrorCode(record.code) &&
    isNonemptyString(record.error) &&
    typeof record.retryable === 'boolean' &&
    (!hasOwn(record, 'details') || isRecord(record.details))
  );
}

function validateRunBase(record: RecordValue): boolean {
  return (
    isMobileV2LegacyRunId(record.id) &&
    isUuid(record.conversationId) &&
    isMobileV2LegacyRunId(record.runId) &&
    record.id === record.runId &&
    isMobileV2LegacyRunId(record.segmentTurnId) &&
    isNonnegativeSafeInteger(record.v2Seq)
  );
}

function validateAccepted(record: RecordValue): boolean {
  return (
    hasExactKeys(record, [
      'type',
      'id',
      'conversationId',
      'runId',
      'segmentTurnId',
      'v2Seq',
      'userMessageId',
      'assistantMessageId',
      'revision',
    ]) &&
    validateRunBase(record) &&
    isUuid(record.userMessageId) &&
    isUuid(record.assistantMessageId) &&
    isNonnegativeSafeInteger(record.revision)
  );
}

function validateEvent(record: RecordValue): boolean {
  return (
    hasExactKeys(record, [
      'type',
      'id',
      'conversationId',
      'runId',
      'segmentTurnId',
      'v2Seq',
      'event',
    ]) &&
    validateRunBase(record) &&
    isMobileAgentEvent(record.event)
  );
}

function validateDone(record: RecordValue): boolean {
  return (
    hasExactKeys(record, [
      'type',
      'id',
      'conversationId',
      'runId',
      'segmentTurnId',
      'v2Seq',
      'outcome',
    ]) &&
    validateRunBase(record) &&
    ['completed', 'cancelled', 'interrupted'].includes(record.outcome as string)
  );
}

function validateError(record: RecordValue): boolean {
  return (
    hasExactKeys(
      record,
      ['type', 'id', 'conversationId', 'runId', 'segmentTurnId', 'v2Seq', 'error'],
      ['code', 'retryable'],
    ) &&
    validateRunBase(record) &&
    isNonemptyString(record.error) &&
    (!hasOwn(record, 'code') || isApiErrorCode(record.code)) &&
    (!hasOwn(record, 'retryable') || typeof record.retryable === 'boolean')
  );
}

function validateInputBase(record: RecordValue, extraRequired: readonly string[] = []): boolean {
  return (
    isUuid(record.id) &&
    isUuid(record.conversationId) &&
    isNonnegativeSafeInteger(record.v2Seq) &&
    isNonnegativeSafeInteger(record.queueRevision) &&
    isPendingInput(record.input) &&
    extraRequired.every((key) => hasOwn(record, key))
  );
}

function validateInputTransition(record: RecordValue): boolean {
  return (
    hasExactKeys(record, ['type', 'id', 'conversationId', 'v2Seq', 'queueRevision', 'input']) &&
    validateInputBase(record)
  );
}

function validateInputDelivered(record: RecordValue): boolean {
  return (
    hasExactKeys(record, [
      'type',
      'id',
      'conversationId',
      'v2Seq',
      'queueRevision',
      'input',
      'runId',
      'segmentTurnId',
      'userMessageId',
      'assistantMessageId',
    ]) &&
    validateInputBase(record) &&
    isMobileV2LegacyRunId(record.runId) &&
    isUuid(record.segmentTurnId) &&
    isUuid(record.userMessageId) &&
    isUuid(record.assistantMessageId)
  );
}

function validateQueueTransition(record: RecordValue): boolean {
  return (
    hasExactKeys(
      record,
      ['type', 'conversationId', 'v2Seq', 'queueRevision', 'queuePaused', 'pendingFollowUpCount'],
      ['id'],
    ) &&
    (!hasOwn(record, 'id') || isUuid(record.id)) &&
    isUuid(record.conversationId) &&
    isNonnegativeSafeInteger(record.v2Seq) &&
    isNonnegativeSafeInteger(record.queueRevision) &&
    typeof record.queuePaused === 'boolean' &&
    isNonnegativeSafeInteger(record.pendingFollowUpCount)
  );
}

/** Parse the untrusted WebSocket JSON boundary before transport state lookup or mutation. */
export function parseMobileV2ServerFrame(value: unknown): MobileV2WsServerFrame {
  if (!isRecord(value) || typeof value.type !== 'string') throw protocolError();
  let valid = false;
  switch (value.type) {
    case 'hello_ack':
      valid = validateHelloAck(value);
      break;
    case 'conversation_subscribed':
      valid = validateConversationSubscribed(value);
      break;
    case 'command_rejected':
      valid = validateCommandRejected(value);
      break;
    case 'accepted':
      valid = validateAccepted(value);
      break;
    case 'event':
      valid = validateEvent(value);
      break;
    case 'done':
      valid = validateDone(value);
      break;
    case 'error':
      valid = validateError(value);
      break;
    case 'input_accepted':
    case 'input_updated':
    case 'input_removed':
    case 'input_failed':
      valid = validateInputTransition(value);
      break;
    case 'input_delivered':
      valid = validateInputDelivered(value);
      break;
    case 'queue_paused':
    case 'queue_resumed':
      valid = validateQueueTransition(value);
      break;
  }
  if (!valid) throw protocolError();
  return value as unknown as MobileV2WsServerFrame;
}

function reconnectDelay(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** attempt);
}

function closeError(code: number, reason: string): ResumableChatTransportError | null {
  if (code === 4001 || code === 4401) {
    return new ResumableChatTransportError(
      'repair_required',
      'Gateway authorization failed. Reconnect this gateway to continue.',
      undefined,
      false,
      undefined,
      undefined,
      code,
    );
  }
  if (code === 4429) {
    return new ResumableChatTransportError(
      'rate_limited',
      'Gateway rate limit reached. Retry when the countdown finishes.',
      'rate_limited',
      true,
      undefined,
      parseChatRetryAfterMs(reason),
      code,
    );
  }
  if (code === 1002 && PROTOCOL_CLOSE_REASONS.has(reason)) {
    return protocolError(reason, code);
  }
  return null;
}

function commandApiError(
  frame: Extract<MobileV2WsServerFrame, { type: 'command_rejected' }>,
): MobileApiError {
  return {
    code: frame.code,
    error: frame.error,
    retryable: frame.retryable,
    ...(frame.details === undefined ? {} : { details: frame.details }),
  };
}

function isValidPromiseCommandFrame(frame: PromiseCommandFrame): boolean {
  switch (frame.type) {
    case 'message':
      return (
        isMobileV2LegacyRunId(frame.id) &&
        isNonemptyString(frame.agentId) &&
        isNonemptyString(frame.channelId) &&
        isUuid(frame.conversationId) &&
        typeof frame.text === 'string' &&
        frame.resumable === true &&
        (frame.images === undefined || isImages(frame.images)) &&
        (frame.location === undefined || isClientLocation(frame.location))
      );
    case 'enqueue_input':
      return (
        isUuid(frame.id) &&
        isUuid(frame.inputId) &&
        isNonemptyString(frame.agentId) &&
        isNonemptyString(frame.channelId) &&
        isUuid(frame.conversationId) &&
        typeof frame.text === 'string' &&
        (frame.images === undefined || isImages(frame.images)) &&
        ((frame.behavior === 'steer' && isMobileV2LegacyRunId(frame.expectedActiveTurnId)) ||
          (frame.behavior === 'followUp' && frame.expectedActiveTurnId === undefined))
      );
    case 'edit_follow_up':
      return (
        isUuid(frame.id) &&
        isUuid(frame.conversationId) &&
        isUuid(frame.inputId) &&
        isNonnegativeSafeInteger(frame.expectedRevision) &&
        typeof frame.text === 'string' &&
        (frame.images === undefined || isImages(frame.images))
      );
    case 'remove_follow_up':
      return (
        isUuid(frame.id) &&
        isUuid(frame.conversationId) &&
        isUuid(frame.inputId) &&
        isNonnegativeSafeInteger(frame.expectedRevision)
      );
    case 'resume_follow_ups':
      return (
        isUuid(frame.id) &&
        isUuid(frame.conversationId) &&
        isNonnegativeSafeInteger(frame.expectedQueueRevision)
      );
  }
}

function sameFrame(left: PromiseCommandFrame, right: PromiseCommandFrame): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const defaultSocketFactory: ChatSocketFactory = (url, options) =>
  new WebSocket(url, { headers: options.headers }) as unknown as ChatSocket;

export class ConversationChatTransport {
  private readonly states = new Map<string, ConversationState>();
  private readonly socketFactory: ChatSocketFactory;
  private closed = false;

  constructor(private readonly options: ConversationChatTransportOptions) {
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
  }

  open(conversation: ConversationSummary, sinceV2Seq: number): Promise<void> {
    this.assertOpen();
    if (!isUuid(conversation.id) || !isNonnegativeSafeInteger(sinceV2Seq)) {
      throw new Error('Invalid conversation subscription');
    }
    const current = this.states.get(conversation.id);
    if (current) return this.forceRebase(current, conversation, sinceV2Seq);

    const opening = deferred<void>();
    const state: ConversationState = {
      conversation,
      lastV2Seq: sinceV2Seq,
      socket: null,
      generation: 0,
      negotiated: false,
      subscribed: false,
      pendingSubscriptionId: null,
      opening,
      pendingCommands: new Map(),
      stickyCancels: new Set(),
      unsentAnswers: [],
      legacyCorrelations: new Set(),
      reconnectAttempt: 0,
      reconnectTimer: null,
      terminal: false,
    };
    this.states.set(conversation.id, state);
    this.connect(state);
    return opening.promise;
  }

  send(
    conversation: ConversationSummary,
    turnId: string,
    text: string,
    images?: MobileImage[],
    location?: MobileClientLocation,
  ): Promise<AcceptedFrame> {
    const frame = {
      type: 'message',
      id: turnId,
      agentId: conversation.agentId,
      channelId: this.options.channelId,
      conversationId: conversation.id,
      text,
      ...(location ? { location } : {}),
      ...(images?.length ? { images } : {}),
      resumable: true,
    } satisfies MobileV2WsClientFrame;
    return this.promiseCommand(conversation, frame, 'send', 'accepted') as Promise<AcceptedFrame>;
  }

  enqueueInput(
    conversation: ConversationSummary,
    command: EnqueueInputCommand,
  ): Promise<InputAcceptedFrame> {
    const frame = {
      type: 'enqueue_input',
      id: command.commandId,
      inputId: command.inputId,
      agentId: conversation.agentId,
      channelId: this.options.channelId,
      conversationId: conversation.id,
      text: command.text,
      ...(command.images?.length ? { images: command.images } : {}),
      behavior: command.behavior,
      ...(command.expectedActiveTurnId === undefined
        ? {}
        : { expectedActiveTurnId: command.expectedActiveTurnId }),
    } satisfies MobileV2WsClientFrame;
    return this.promiseCommand(
      conversation,
      frame,
      'queue',
      'input_accepted',
    ) as Promise<InputAcceptedFrame>;
  }

  editFollowUp(
    conversation: ConversationSummary,
    command: EditFollowUpCommand,
  ): Promise<InputUpdatedFrame> {
    const frame = {
      type: 'edit_follow_up',
      id: command.commandId,
      conversationId: conversation.id,
      inputId: command.inputId,
      expectedRevision: command.expectedRevision,
      text: command.text,
      ...(command.images?.length ? { images: command.images } : {}),
    } satisfies MobileV2WsClientFrame;
    return this.promiseCommand(
      conversation,
      frame,
      'queue',
      'input_updated',
    ) as Promise<InputUpdatedFrame>;
  }

  removeFollowUp(
    conversation: ConversationSummary,
    commandId: string,
    inputId: string,
    expectedRevision: number,
  ): Promise<InputRemovedFrame> {
    return this.promiseCommand(
      conversation,
      {
        type: 'remove_follow_up',
        id: commandId,
        conversationId: conversation.id,
        inputId,
        expectedRevision,
      },
      'queue',
      'input_removed',
    ) as Promise<InputRemovedFrame>;
  }

  resumeFollowUps(
    conversation: ConversationSummary,
    commandId: string,
    expectedQueueRevision: number,
  ): Promise<QueueResumedFrame> {
    return this.promiseCommand(
      conversation,
      {
        type: 'resume_follow_ups',
        id: commandId,
        conversationId: conversation.id,
        expectedQueueRevision,
      },
      'queue',
      'queue_resumed',
    ) as Promise<QueueResumedFrame>;
  }

  cancel(conversationId: string, runId: string): void {
    const state = this.states.get(conversationId);
    if (!state || state.terminal || !isMobileV2LegacyRunId(runId)) return;
    state.stickyCancels.add(runId);
    state.legacyCorrelations.add(runId);
    if (state.subscribed && state.socket?.readyState === 1) {
      this.tryWrite(state, state.socket, { type: 'cancel', id: runId });
    }
  }

  answer(conversationId: string, runId: string, questionId: string, answer: string): void {
    const state = this.states.get(conversationId);
    if (!state || state.terminal || !isMobileV2LegacyRunId(runId)) {
      throw new Error(`No active conversation "${conversationId}" for run "${runId}"`);
    }
    const frame = { type: 'answer', id: runId, questionId, answer } satisfies AnswerFrame;
    state.legacyCorrelations.add(runId);
    state.unsentAnswers.push(frame);
    if (state.subscribed && state.socket?.readyState === 1) {
      this.flushAnswers(state, state.socket);
    }
  }

  closeConversation(conversationId: string): void {
    const state = this.states.get(conversationId);
    if (!state) return;
    this.terminate(state, new Error('Conversation chat closed'), false);
  }

  closeAll(): void {
    this.closed = true;
    for (const state of [...this.states.values()]) {
      this.terminate(state, new Error('Chat transport closed'), false);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Chat transport closed');
  }

  private stateFor(conversation: ConversationSummary): ConversationState {
    this.assertOpen();
    const state = this.states.get(conversation.id);
    if (!state || state.terminal) {
      throw new Error(`Conversation "${conversation.id}" is not open`);
    }
    return state;
  }

  private promiseCommand(
    conversation: ConversationSummary,
    frame: PromiseCommandFrame,
    kind: PendingCommand['kind'],
    expectedType: MobileV2SequencedFrame['type'],
  ): Promise<MobileV2SequencedFrame> {
    const state = this.stateFor(conversation);
    if (!isValidPromiseCommandFrame(frame) || frame.conversationId !== state.conversation.id) {
      throw new Error('Invalid chat command');
    }
    const existing = state.pendingCommands.get(frame.id);
    if (existing) {
      if (
        existing.kind !== kind ||
        existing.expectedType !== expectedType ||
        !sameFrame(existing.frame, frame)
      ) {
        throw new Error(`Chat command "${frame.id}" is already pending`);
      }
      if (state.subscribed && state.socket?.readyState === 1) {
        this.tryWrite(state, state.socket, frame);
      }
      return existing.deferred.promise;
    }
    const pending: PendingCommand = {
      kind,
      expectedType,
      frame,
      deferred: deferred<MobileV2SequencedFrame>(),
    };
    state.pendingCommands.set(frame.id, pending);
    if (state.subscribed && state.socket?.readyState === 1) {
      this.tryWrite(state, state.socket, frame);
    }
    return pending.deferred.promise;
  }

  private forceRebase(
    state: ConversationState,
    conversation: ConversationSummary,
    sinceV2Seq: number,
  ): Promise<void> {
    state.opening?.reject(new Error('Conversation subscription superseded'));
    const opening = deferred<void>();
    state.opening = opening;
    state.conversation = conversation;
    state.lastV2Seq = sinceV2Seq;
    state.negotiated = false;
    state.subscribed = false;
    state.pendingSubscriptionId = null;
    state.terminal = false;
    this.clearReconnect(state);
    state.generation += 1;
    const socket = state.socket;
    state.socket = null;
    socket?.close();

    const activeTurnId = conversation.activeTurnId;
    for (const runId of [...state.stickyCancels]) {
      if (runId !== activeTurnId) state.stickyCancels.delete(runId);
    }
    state.unsentAnswers = state.unsentAnswers.filter((frame) => frame.id === activeTurnId);
    for (const runId of [...state.legacyCorrelations]) {
      if (runId !== activeTurnId) state.legacyCorrelations.delete(runId);
    }
    this.connect(state);
    return opening.promise;
  }

  private connect(state: ConversationState): void {
    if (this.closed || state.terminal || this.states.get(state.conversation.id) !== state) return;
    let socket: ChatSocket;
    try {
      socket = this.socketFactory(this.options.connection.url, {
        headers: this.options.connection.headers,
      });
    } catch (error) {
      this.terminate(state, this.asTransportError(error), true);
      return;
    }
    state.generation += 1;
    const generation = state.generation;
    state.socket = socket;
    state.negotiated = false;
    state.subscribed = false;
    state.pendingSubscriptionId = null;

    socket.addEventListener('open', () => {
      if (!this.isCurrent(state, socket, generation)) return;
      state.reconnectAttempt = 0;
      this.tryWrite(state, socket, {
        type: 'hello',
        contractVersion: MOBILE_V2_CONTRACT_VERSION,
        capabilities: [CHAT_INPUT_QUEUE_CAPABILITY],
      });
    });
    socket.addEventListener('message', (event) => {
      let frame: MobileV2WsServerFrame;
      try {
        const raw = typeof event.data === 'string' ? event.data : String(event.data);
        frame = parseMobileV2ServerFrame(JSON.parse(raw) as unknown);
      } catch (error) {
        if (!this.isCurrent(state, socket, generation)) return;
        this.terminate(
          state,
          error instanceof ResumableChatTransportError ? error : protocolError(),
          true,
        );
        return;
      }
      if (!this.isCurrent(state, socket, generation)) return;
      try {
        this.receive(state, frame);
      } catch (error) {
        this.terminate(state, this.asTransportError(error), true);
      }
    });
    socket.addEventListener('close', (event) => {
      if (!this.isCurrent(state, socket, generation)) return;
      state.socket = null;
      state.negotiated = false;
      state.subscribed = false;
      state.pendingSubscriptionId = null;
      state.generation += 1;
      if (state.terminal || this.closed) return;
      const code = event.code ?? 1006;
      const reason = event.reason ?? '';
      const terminalError = closeError(code, reason);
      if (terminalError) {
        this.terminate(state, terminalError, true);
        return;
      }
      this.scheduleReconnect(state);
    });
  }

  private receive(state: ConversationState, frame: MobileV2WsServerFrame): void {
    switch (frame.type) {
      case 'hello_ack':
        if (state.negotiated || state.pendingSubscriptionId !== null) throw protocolError();
        state.negotiated = true;
        state.pendingSubscriptionId = crypto.randomUUID();
        this.tryWrite(state, state.socket as ChatSocket, {
          type: 'subscribe_conversation',
          id: state.pendingSubscriptionId,
          agentId: state.conversation.agentId,
          conversationId: state.conversation.id,
          sinceV2Seq: state.lastV2Seq,
        });
        return;
      case 'conversation_subscribed':
        this.receiveSubscribed(state, frame);
        return;
      case 'command_rejected':
        this.receiveRejected(state, frame);
        return;
      default:
        if (!state.negotiated) throw protocolError();
        this.applySequenced(state, frame);
    }
  }

  private receiveSubscribed(
    state: ConversationState,
    frame: Extract<MobileV2WsServerFrame, { type: 'conversation_subscribed' }>,
  ): void {
    if (frame.id !== state.pendingSubscriptionId) return;
    if (frame.conversationId !== state.conversation.id) throw protocolError();
    if (frame.v2ThroughSeq !== state.lastV2Seq) throw protocolError();
    state.pendingSubscriptionId = null;
    state.subscribed = true;
    state.opening?.resolve(undefined);
    state.opening = null;
    this.flushAfterSubscription(state);
  }

  private receiveRejected(
    state: ConversationState,
    frame: Extract<MobileV2WsServerFrame, { type: 'command_rejected' }>,
  ): void {
    const apiError = commandApiError(frame);
    const commandError = new ConversationChatCommandError(frame.id, apiError);
    if (frame.id === state.pendingSubscriptionId) {
      if (frame.conversationId !== state.conversation.id) throw protocolError();
      state.opening?.reject(commandError);
      this.terminate(state, commandError, false);
      return;
    }

    const pending = state.pendingCommands.get(frame.id);
    const legacyCorrelation = state.legacyCorrelations.has(frame.id);
    if (frame.conversationId === undefined) {
      if (legacyCorrelation) {
        this.options.onCommandError(state.conversation.id, commandError);
        return;
      }
      if (pending?.kind === 'queue') throw protocolError();
      return;
    }
    if (frame.conversationId !== state.conversation.id) {
      if (pending || legacyCorrelation) throw protocolError();
      return;
    }
    if (pending) {
      state.pendingCommands.delete(frame.id);
      pending.deferred.reject(commandError);
      return;
    }
    if (legacyCorrelation) this.options.onCommandError(state.conversation.id, commandError);
  }

  private applySequenced(state: ConversationState, frame: MobileV2SequencedFrame): void {
    if (frame.conversationId !== state.conversation.id) throw protocolError();
    const commandId = typeof frame.id === 'string' ? frame.id : undefined;
    const pending = commandId ? state.pendingCommands.get(commandId) : undefined;
    if (frame.v2Seq <= state.lastV2Seq) {
      if (commandId && pending?.expectedType === frame.type) {
        state.pendingCommands.delete(commandId);
        pending.deferred.resolve(frame);
      }
      return;
    }
    if (frame.v2Seq !== state.lastV2Seq + 1) {
      this.restart(state);
      return;
    }
    state.lastV2Seq = frame.v2Seq;
    this.options.onFrame(frame);
    if (commandId && pending?.expectedType === frame.type) {
      state.pendingCommands.delete(commandId);
      pending.deferred.resolve(frame);
    }
    if (frame.type === 'done' || frame.type === 'error') {
      state.stickyCancels.delete(frame.runId);
      state.unsentAnswers = state.unsentAnswers.filter((answer) => answer.id !== frame.runId);
      state.legacyCorrelations.delete(frame.runId);
    }
  }

  private flushAfterSubscription(state: ConversationState): void {
    const socket = state.socket;
    if (!socket || socket.readyState !== 1) return;
    for (const runId of state.stickyCancels) {
      if (!this.tryWrite(state, socket, { type: 'cancel', id: runId })) return;
    }
    if (!this.flushAnswers(state, socket)) return;
    for (const pending of state.pendingCommands.values()) {
      if (!this.tryWrite(state, socket, pending.frame)) return;
    }
  }

  private flushAnswers(state: ConversationState, socket: ChatSocket): boolean {
    while (state.unsentAnswers.length > 0) {
      const answer = state.unsentAnswers[0] as AnswerFrame;
      if (!this.tryWrite(state, socket, answer)) return false;
      state.unsentAnswers.shift();
    }
    return true;
  }

  private tryWrite(
    state: ConversationState,
    socket: ChatSocket,
    frame: MobileV2WsClientFrame,
  ): boolean {
    if (state.socket !== socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      this.restart(state);
      return false;
    }
  }

  private isCurrent(state: ConversationState, socket: ChatSocket, generation: number): boolean {
    return (
      !this.closed &&
      !state.terminal &&
      this.states.get(state.conversation.id) === state &&
      state.socket === socket &&
      state.generation === generation
    );
  }

  private scheduleReconnect(state: ConversationState): void {
    if (state.reconnectTimer || state.terminal || this.closed) return;
    const delay = reconnectDelay(state.reconnectAttempt);
    state.reconnectAttempt += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      this.connect(state);
    }, delay);
  }

  private restart(state: ConversationState): void {
    if (state.terminal || this.closed || this.states.get(state.conversation.id) !== state) return;
    state.negotiated = false;
    state.subscribed = false;
    state.pendingSubscriptionId = null;
    state.generation += 1;
    const socket = state.socket;
    state.socket = null;
    socket?.close();
    this.scheduleReconnect(state);
  }

  private clearReconnect(state: ConversationState): void {
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  private asTransportError(error: unknown): ResumableChatTransportError {
    if (error instanceof ResumableChatTransportError) return error;
    return protocolError(error instanceof Error ? error.message : String(error));
  }

  private terminate(state: ConversationState, error: Error, notify: boolean): void {
    if (state.terminal || this.states.get(state.conversation.id) !== state) return;
    state.terminal = true;
    state.opening?.reject(error);
    state.opening = null;
    for (const pending of state.pendingCommands.values()) pending.deferred.reject(error);
    state.pendingCommands.clear();
    state.stickyCancels.clear();
    state.unsentAnswers = [];
    state.legacyCorrelations.clear();
    this.clearReconnect(state);
    this.states.delete(state.conversation.id);
    state.generation += 1;
    const socket = state.socket;
    state.socket = null;
    socket?.close();
    if (notify && error instanceof ResumableChatTransportError) {
      this.options.onConnectionError(state.conversation.id, error);
    }
  }
}
