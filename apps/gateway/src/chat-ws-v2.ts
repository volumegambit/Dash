import { type MobileV2WsClientFrame, isMobileV2LegacyRunId } from '@dash/mobile-contract-v2';
import { toClientLocationV2 } from './client-location.js';

export type MobileV2FrameParseResult =
  | { kind: 'valid'; frame: MobileV2WsClientFrame }
  | {
      kind: 'rejectable';
      id: string;
      conversationId?: string;
      code: 'validation_failed';
      error: string;
    }
  | { kind: 'fatal'; reason: 'invalid_frame' };

type RecordValue = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const V2_FRAME_TYPES = new Set([
  'hello',
  'subscribe_conversation',
  'message',
  'enqueue_input',
  'edit_follow_up',
  'remove_follow_up',
  'resume_follow_ups',
  'answer',
  'cancel',
]);
const UUID_CORRELATION_TYPES = new Set([
  'subscribe_conversation',
  'enqueue_input',
  'edit_follow_up',
  'remove_follow_up',
  'resume_follow_ups',
]);
const LEGACY_CORRELATION_TYPES = new Set(['message', 'answer', 'cancel']);
const CONVERSATION_COMMAND_TYPES = new Set([
  'subscribe_conversation',
  'message',
  'enqueue_input',
  'edit_follow_up',
  'remove_follow_up',
  'resume_follow_ups',
]);
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_ENCODED_IMAGE_CHARACTERS = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
const MAX_VALIDATION_ERROR_CHARACTERS = 160;
const SUMMARY_FIELDS = new Set([
  'type',
  'id',
  'inputId',
  'agentId',
  'channelId',
  'conversationId',
  'questionId',
  'contractVersion',
  'capabilities',
  'sinceV2Seq',
  'resumable',
  'expectedRevision',
  'expectedQueueRevision',
  'expectedActiveTurnId',
  'behavior',
  'text',
  'answer',
  'images',
  'location',
]);

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasExactKeys(
  record: RecordValue,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return (
    Object.keys(record).every((key) => allowedSet.has(key)) &&
    required.every((key) => hasOwn(record, key))
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBase64AlphabetCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 43 ||
    code === 47
  );
}

function decodedCanonicalBase64Bytes(data: unknown): number {
  if (
    typeof data !== 'string' ||
    data.length === 0 ||
    data.length > MAX_ENCODED_IMAGE_CHARACTERS ||
    data.length % 4 !== 0
  ) {
    return -1;
  }
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  for (let index = 0; index < data.length - padding; index += 1) {
    if (!isBase64AlphabetCode(data.charCodeAt(index))) return -1;
  }
  for (let index = data.length - padding; index < data.length; index += 1) {
    if (data.charCodeAt(index) !== 61) return -1;
  }
  const decoded = Buffer.from(data, 'base64');
  if (decoded.toString('base64') !== data) return -1;
  return decoded.byteLength;
}

function isValidImages(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_IMAGES) return false;
  let totalBytes = 0;
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ['mediaType', 'data'], ['mediaType', 'data']) ||
      typeof item.mediaType !== 'string' ||
      !ALLOWED_IMAGE_TYPES.has(item.mediaType)
    ) {
      return false;
    }
    const bytes = decodedCanonicalBase64Bytes(item.data);
    if (bytes < 0 || bytes > MAX_IMAGE_BYTES) return false;
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) return false;
  }
  return true;
}

function hasValidOptionalImages(record: RecordValue): boolean {
  return !hasOwn(record, 'images') || isValidImages(record.images);
}

function hasValidOptionalLocation(record: RecordValue): boolean {
  return !hasOwn(record, 'location') || toClientLocationV2(record.location) !== undefined;
}

function isValidBody(type: string, record: RecordValue): boolean {
  switch (type) {
    case 'hello':
      return (
        hasExactKeys(
          record,
          ['type', 'contractVersion', 'capabilities'],
          ['type', 'contractVersion', 'capabilities'],
        ) &&
        record.contractVersion === 2 &&
        Array.isArray(record.capabilities) &&
        record.capabilities.every(isNonemptyString) &&
        new Set(record.capabilities).size === record.capabilities.length
      );
    case 'subscribe_conversation':
      return (
        hasExactKeys(
          record,
          ['type', 'id', 'agentId', 'conversationId', 'sinceV2Seq'],
          ['type', 'id', 'agentId', 'conversationId', 'sinceV2Seq'],
        ) &&
        isNonemptyString(record.agentId) &&
        isUuid(record.conversationId) &&
        isNonnegativeSafeInteger(record.sinceV2Seq)
      );
    case 'message':
      return (
        hasExactKeys(
          record,
          [
            'type',
            'id',
            'agentId',
            'channelId',
            'conversationId',
            'text',
            'images',
            'location',
            'resumable',
          ],
          ['type', 'id', 'agentId', 'channelId', 'conversationId', 'text', 'resumable'],
        ) &&
        isNonemptyString(record.agentId) &&
        isNonemptyString(record.channelId) &&
        isUuid(record.conversationId) &&
        typeof record.text === 'string' &&
        record.resumable === true &&
        hasValidOptionalImages(record) &&
        hasValidOptionalLocation(record)
      );
    case 'enqueue_input': {
      if (
        !hasExactKeys(
          record,
          [
            'type',
            'id',
            'inputId',
            'agentId',
            'channelId',
            'conversationId',
            'text',
            'images',
            'behavior',
            'expectedActiveTurnId',
          ],
          ['type', 'id', 'inputId', 'agentId', 'channelId', 'conversationId', 'text', 'behavior'],
        ) ||
        !isUuid(record.inputId) ||
        !isNonemptyString(record.agentId) ||
        !isNonemptyString(record.channelId) ||
        !isUuid(record.conversationId) ||
        typeof record.text !== 'string' ||
        !hasValidOptionalImages(record)
      ) {
        return false;
      }
      if (record.behavior === 'steer') {
        return (
          hasOwn(record, 'expectedActiveTurnId') &&
          isMobileV2LegacyRunId(record.expectedActiveTurnId)
        );
      }
      return record.behavior === 'followUp' && !hasOwn(record, 'expectedActiveTurnId');
    }
    case 'edit_follow_up':
      return (
        hasExactKeys(
          record,
          ['type', 'id', 'conversationId', 'inputId', 'expectedRevision', 'text', 'images'],
          ['type', 'id', 'conversationId', 'inputId', 'expectedRevision', 'text'],
        ) &&
        isUuid(record.conversationId) &&
        isUuid(record.inputId) &&
        isNonnegativeSafeInteger(record.expectedRevision) &&
        typeof record.text === 'string' &&
        hasValidOptionalImages(record)
      );
    case 'remove_follow_up':
      return (
        hasExactKeys(
          record,
          ['type', 'id', 'conversationId', 'inputId', 'expectedRevision'],
          ['type', 'id', 'conversationId', 'inputId', 'expectedRevision'],
        ) &&
        isUuid(record.conversationId) &&
        isUuid(record.inputId) &&
        isNonnegativeSafeInteger(record.expectedRevision)
      );
    case 'resume_follow_ups':
      return (
        hasExactKeys(
          record,
          ['type', 'id', 'conversationId', 'expectedQueueRevision'],
          ['type', 'id', 'conversationId', 'expectedQueueRevision'],
        ) &&
        isUuid(record.conversationId) &&
        isNonnegativeSafeInteger(record.expectedQueueRevision)
      );
    case 'answer':
      return (
        hasExactKeys(
          record,
          ['type', 'id', 'questionId', 'answer'],
          ['type', 'id', 'questionId', 'answer'],
        ) &&
        isNonemptyString(record.questionId) &&
        typeof record.answer === 'string'
      );
    case 'cancel':
      return hasExactKeys(record, ['type', 'id'], ['type', 'id']);
    default:
      return false;
  }
}

function rejectable(type: string, id: string, record: RecordValue): MobileV2FrameParseResult {
  const error = `Invalid ${type} frame`.slice(0, MAX_VALIDATION_ERROR_CHARACTERS);
  const conversationId =
    CONVERSATION_COMMAND_TYPES.has(type) && isUuid(record.conversationId)
      ? record.conversationId
      : undefined;
  return {
    kind: 'rejectable',
    id,
    ...(conversationId !== undefined ? { conversationId } : {}),
    code: 'validation_failed',
    error,
  };
}

export function parseMobileV2ClientFrame(value: unknown): MobileV2FrameParseResult {
  if (!isRecord(value) || typeof value.type !== 'string' || !V2_FRAME_TYPES.has(value.type)) {
    return { kind: 'fatal', reason: 'invalid_frame' };
  }
  const type = value.type;
  if (type === 'hello') {
    return isValidBody(type, value)
      ? { kind: 'valid', frame: value as MobileV2WsClientFrame }
      : { kind: 'fatal', reason: 'invalid_frame' };
  }

  const id = value.id;
  if (
    (UUID_CORRELATION_TYPES.has(type) && !isUuid(id)) ||
    (LEGACY_CORRELATION_TYPES.has(type) && !isMobileV2LegacyRunId(id))
  ) {
    return { kind: 'fatal', reason: 'invalid_frame' };
  }
  if (typeof id !== 'string') return { kind: 'fatal', reason: 'invalid_frame' };
  if (!isValidBody(type, value)) return rejectable(type, id, value);
  return { kind: 'valid', frame: value as MobileV2WsClientFrame };
}

function addStringByteLength(
  summary: Record<string, unknown>,
  record: RecordValue,
  key: string,
): void {
  const value = record[key];
  if (typeof value === 'string') summary[`${key}Bytes`] = Buffer.byteLength(value);
}

export function summarizeMobileV2Inbound(raw: string, value: unknown): Record<string, unknown> {
  const byteLength = Buffer.byteLength(raw);
  if (!isRecord(value) || typeof value.type !== 'string' || !V2_FRAME_TYPES.has(value.type)) {
    return { byteLength };
  }
  const summary: Record<string, unknown> = {
    frameType: value.type,
    byteLength,
    recognizedKeys: Object.keys(value)
      .filter((key) => SUMMARY_FIELDS.has(key))
      .sort(),
  };
  for (const key of [
    'id',
    'inputId',
    'agentId',
    'channelId',
    'conversationId',
    'questionId',
    'expectedActiveTurnId',
  ]) {
    addStringByteLength(summary, value, key);
  }
  for (const key of ['sinceV2Seq', 'expectedRevision', 'expectedQueueRevision']) {
    if (isNonnegativeSafeInteger(value[key])) summary[key] = value[key];
  }
  if (typeof value.contractVersion === 'number') summary.contractVersion = value.contractVersion;
  if (typeof value.resumable === 'boolean') summary.resumable = value.resumable;
  if (value.behavior === 'steer' || value.behavior === 'followUp') {
    summary.behavior = value.behavior;
  }
  if (Array.isArray(value.capabilities)) summary.capabilityCount = value.capabilities.length;
  if (typeof value.text === 'string') summary.textBytes = Buffer.byteLength(value.text);
  if (typeof value.answer === 'string') summary.answerBytes = Buffer.byteLength(value.answer);
  if (Array.isArray(value.images)) {
    summary.imageCount = value.images.length;
    summary.imageDataBytes = value.images.reduce((total, image) => {
      if (!isRecord(image) || typeof image.data !== 'string') return total;
      return total + Buffer.byteLength(image.data);
    }, 0);
  }
  if (isRecord(value.location)) {
    summary.hasLocation = true;
    summary.hasPreciseLocation = isRecord(value.location.precise);
  }
  return summary;
}
