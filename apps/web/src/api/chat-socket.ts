import type {
  MobileAgentEvent,
  MobileApiErrorCode,
  MobileImage,
  MobileWsClientFrame,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
import {
  CHAT_INPUT_QUEUE_CAPABILITY,
  MOBILE_V2_CONTRACT_VERSION,
  type MobileV2PendingInput,
  type MobileV2WsClientFrame,
  type MobileV2WsServerFrame,
  isMobileV2LegacyRunId,
} from '@dash/mobile-contract-v2';
import type { MobileRestClient } from './rest';

export type FrameHandler = (frame: MobileWsServerFrame | MobileV2WsServerFrame) => void;

export type ChatSocketProtocol = { version: 1 } | { version: 2; capabilities: string[] };

export type GatewayProtocolCloseReason =
  | 'unsupported_version'
  | 'unexpected_hello'
  | 'hello_required'
  | 'invalid_frame';

export type ChatSocketClose =
  | {
      kind: 'protocol';
      code: 1002;
      reason: GatewayProtocolCloseReason;
      retryable: false;
    }
  | { kind: 'closed'; code: number; reason: string; retryable: boolean }
  | { kind: 'error'; retryable: boolean };

type RecordValue = Record<string, unknown>;

const WS_OPEN = 1;
const ERROR_CLOSE_GRACE_MS = 1_000;
const LOCAL_PROTOCOL_CLOSE_CODE = 4002;

/** Matches the relay's `APP_SUBPROTOCOL`/`CREDENTIAL_SUBPROTOCOL_PREFIX`
 * constants (`apps/relay/src/relay-server.ts`) exactly. */
const APP_SUBPROTOCOL = 'dash.v1';
const CREDENTIAL_SUBPROTOCOL_PREFIX = 'dash.relay-credential.';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API_ERROR_CODES: ReadonlySet<string> = new Set<MobileApiErrorCode>([
  'unauthorized',
  'not_found',
  'validation_failed',
  'revision_conflict',
  'conversation_busy',
  'rate_limited',
  'gateway_offline',
  'capability_required',
]);
const INPUT_KINDS: ReadonlySet<string> = new Set(['steer', 'follow_up']);
const INPUT_STATES: ReadonlySet<string> = new Set([
  'queued',
  'delivering',
  'delivered',
  'removed',
  'failed',
]);
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);
const PROTOCOL_CLOSE_REASONS: ReadonlySet<string> = new Set<GatewayProtocolCloseReason>([
  'unsupported_version',
  'unexpected_hello',
  'hello_required',
  'invalid_frame',
]);

function isGatewayProtocolCloseReason(reason: string): reason is GatewayProtocolCloseReason {
  return PROTOCOL_CLOSE_REASONS.has(reason);
}

function buildWsUrl(base: string, ticket: string): string {
  const url = new URL(base);
  url.searchParams.set('ticket', ticket);
  return url.toString();
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
  return typeof value === 'string' && API_ERROR_CODES.has(value);
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

function validateInputBase(record: RecordValue): boolean {
  return (
    isUuid(record.id) &&
    isUuid(record.conversationId) &&
    isNonnegativeSafeInteger(record.v2Seq) &&
    isNonnegativeSafeInteger(record.queueRevision) &&
    isPendingInput(record.input)
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

/** Parse the untrusted v2 WebSocket boundary before handing it to application state. */
export function parseMobileV2ServerFrame(value: unknown): MobileV2WsServerFrame {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('ChatSocket: invalid v2 server frame');
  }
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
  if (!valid) throw new Error('ChatSocket: invalid v2 server frame');
  return value as MobileV2WsServerFrame;
}

function handshakeFailure(value: unknown): GatewayProtocolCloseReason | null {
  if (!isRecord(value) || value.type !== 'hello_ack') {
    try {
      parseMobileV2ServerFrame(value);
      return 'hello_required';
    } catch {
      return 'invalid_frame';
    }
  }
  if (!hasExactKeys(value, ['type', 'contractVersion', 'capabilities'])) {
    return 'invalid_frame';
  }
  if (value.contractVersion !== MOBILE_V2_CONTRACT_VERSION) return 'unsupported_version';
  if (
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every(isNonemptyString) ||
    new Set(value.capabilities).size !== value.capabilities.length
  ) {
    return 'invalid_frame';
  }
  if (!value.capabilities.includes(CHAT_INPUT_QUEUE_CAPABILITY)) return 'unsupported_version';
  return null;
}

function classifyClose(
  protocol: ChatSocketProtocol,
  code: number,
  reason: string,
): ChatSocketClose {
  if (protocol.version === 2 && code === 1002 && isGatewayProtocolCloseReason(reason)) {
    return {
      kind: 'protocol',
      code: 1002,
      reason,
      retryable: false,
    };
  }
  return { kind: 'closed', code, reason, retryable: code !== 1000 };
}

function protocolError(reason: GatewayProtocolCloseReason): Error {
  return new Error(`ChatSocket: protocol error (${reason})`);
}

/**
 * Ticketed chat WebSocket client. Tickets are single-use with a 30s TTL
 * (minted by `MobileRestClient.createWsTicket`), so `connect()` always fetches
 * a fresh one — never cache a ticket across calls.
 */
export class ChatSocket {
  private socket: WebSocket | null = null;
  private closeIntent: (() => void) | null = null;
  private generation = 0;
  private applicationReady = false;

  constructor(
    private readonly wsBaseUrl: string,
    private readonly rest: MobileRestClient,
    private readonly onFrame: FrameHandler,
    private readonly onClose: (close: ChatSocketClose) => void,
    private readonly wsFactory: (url: string, protocols?: string[]) => WebSocket = (
      url,
      protocols,
    ) => new WebSocket(url, protocols),
    /** When set, the socket is opened offering `['dash.v1',
     * 'dash.relay-credential.<value>']` as WS subprotocols — the relay
     * validates and strips the credential entry before forwarding upstream
     * and echoes back `dash.v1` as selected. Native/LAN connections (no
     * relay hop) leave this unset and offer no subprotocols at all. */
    private readonly relayCredential?: string,
    private readonly protocol: ChatSocketProtocol = { version: 1 },
  ) {}

  async connect(): Promise<void> {
    const generation = ++this.generation;

    const previous = this.socket;
    this.socket = null;
    this.closeIntent = null;
    this.applicationReady = false;
    previous?.close();

    const { ticket } = await this.rest.createWsTicket();
    if (this.generation !== generation) {
      throw new Error('ChatSocket: connection superseded');
    }
    const url = buildWsUrl(this.wsBaseUrl, ticket);
    const protocols = this.relayCredential
      ? [APP_SUBPROTOCOL, `${CREDENTIAL_SUBPROTOCOL_PREFIX}${this.relayCredential}`]
      : undefined;
    const socket = this.wsFactory(url, protocols);
    if (this.generation !== generation) {
      socket.close();
      throw new Error('ChatSocket: connection superseded');
    }
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      let closeFired = false;
      let negotiated = this.protocol.version === 1;
      let errorFallback: ReturnType<typeof setTimeout> | null = null;
      const isCurrent = () => this.socket === socket && this.generation === generation;
      const clearErrorFallback = () => {
        if (errorFallback === null) return;
        clearTimeout(errorFallback);
        errorFallback = null;
      };
      const fireClose = (close: ChatSocketClose) => {
        if (closeFired) return;
        closeFired = true;
        this.onClose(close);
      };
      const detach = () => {
        if (this.socket === socket) {
          this.socket = null;
          this.closeIntent = null;
        }
        this.applicationReady = false;
      };
      const failProtocol = (reason: GatewayProtocolCloseReason) => {
        if (!isCurrent()) return;
        clearErrorFallback();
        detach();
        fireClose({ kind: 'protocol', code: 1002, reason, retryable: false });
        reject(protocolError(reason));
        socket.close(LOCAL_PROTOCOL_CLOSE_CODE, reason);
      };
      this.closeIntent = () => {
        if (!isCurrent()) return;
        this.generation += 1;
        clearErrorFallback();
        detach();
        fireClose({ kind: 'closed', code: 1000, reason: '', retryable: false });
        reject(new Error('ChatSocket: connection closed before it opened'));
        socket.close();
      };

      socket.addEventListener('open', () => {
        if (!isCurrent()) return;
        if (this.protocol.version === 1) {
          this.applicationReady = true;
          resolve();
          return;
        }
        socket.send(
          JSON.stringify({
            type: 'hello',
            contractVersion: MOBILE_V2_CONTRACT_VERSION,
            capabilities: [CHAT_INPUT_QUEUE_CAPABILITY],
          } satisfies MobileV2WsClientFrame),
        );
      });

      socket.addEventListener('message', (event) => {
        if (!isCurrent()) return;
        const raw = event.data;
        const text = typeof raw === 'string' ? raw : String(raw);
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          if (this.protocol.version === 1) {
            console.warn('ChatSocket: dropping malformed frame from server', text);
            return;
          }
          failProtocol('invalid_frame');
          return;
        }

        if (this.protocol.version === 1) {
          this.onFrame(parsed as MobileWsServerFrame);
          return;
        }

        if (!negotiated) {
          const failure = handshakeFailure(parsed);
          if (failure) {
            failProtocol(failure);
            return;
          }
          negotiated = true;
          this.applicationReady = true;
          resolve();
          return;
        }

        if (isRecord(parsed) && parsed.type === 'hello_ack') {
          failProtocol('unexpected_hello');
          return;
        }
        let frame: MobileV2WsServerFrame;
        try {
          frame = parseMobileV2ServerFrame(parsed);
        } catch {
          failProtocol('invalid_frame');
          return;
        }
        this.onFrame(frame);
      });

      socket.addEventListener('error', () => {
        if (!isCurrent() || closeFired || errorFallback !== null) return;
        errorFallback = setTimeout(() => {
          errorFallback = null;
          if (!isCurrent() || closeFired) return;
          detach();
          fireClose({ kind: 'error', retryable: true });
          reject(new Error('ChatSocket: connection error'));
          socket.close();
        }, ERROR_CLOSE_GRACE_MS);
      });

      socket.addEventListener('close', (event) => {
        if (!isCurrent()) return;
        clearErrorFallback();
        const { code, reason } = event;
        const close = classifyClose(this.protocol, code, reason);
        detach();
        fireClose(close);
        reject(
          close.kind === 'protocol'
            ? protocolError(close.reason)
            : new Error('ChatSocket: connection closed before it opened'),
        );
      });
    });
  }

  send(frame: MobileWsClientFrame | MobileV2WsClientFrame): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN || !this.applicationReady) {
      throw new Error('ChatSocket: cannot send while the socket is not open');
    }
    this.socket.send(JSON.stringify(frame));
  }

  close(): void {
    if (this.closeIntent) {
      this.closeIntent();
      return;
    }
    this.generation += 1;
    this.applicationReady = false;
    this.socket = null;
  }
}
