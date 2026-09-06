import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MobileWsClientFrame } from '@dash/mobile-contract';
import type { MobileV2WsClientFrame, MobileV2WsServerFrame } from '@dash/mobile-contract-v2';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { describe, expect, it, vi } from 'vitest';
import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import { parseMobileV2ClientFrame, summarizeMobileV2Inbound } from './chat-ws-v2.js';
import { mountChatWs } from './chat-ws.js';
import { ConversationServiceError } from './conversation-service.js';
import type { ResumableChatHub, V2ConversationFrameSink } from './resumable-chat-hub.js';

const COMMAND_ID = '10000000-0000-4000-8000-000000000001';
const COMMAND_ID_2 = '10000000-0000-4000-8000-000000000002';
const INPUT_ID = '20000000-0000-4000-8000-000000000001';
const CONVERSATION_ID = '30000000-0000-4000-8000-000000000001';
const RUN_ID = '40000000-0000-4000-8000-000000000001';
const SEGMENT_ID = '50000000-0000-4000-8000-000000000001';
const USER_MESSAGE_ID = '60000000-0000-4000-8000-000000000001';
const ASSISTANT_MESSAGE_ID = '70000000-0000-4000-8000-000000000001';

const HELLO = {
  type: 'hello',
  contractVersion: 2,
  capabilities: ['chat-input-queue-v1'],
} as const;

const SUBSCRIBE = {
  type: 'subscribe_conversation',
  id: COMMAND_ID,
  agentId: 'agent-01',
  conversationId: CONVERSATION_ID,
  sinceV2Seq: 0,
} as const;

const MESSAGE = {
  type: 'message',
  id: RUN_ID,
  agentId: 'agent-01',
  channelId: 'mobile-ios',
  conversationId: CONVERSATION_ID,
  text: 'Hello',
  resumable: true,
} as const;

const ENQUEUE_STEER = {
  type: 'enqueue_input',
  id: COMMAND_ID_2,
  inputId: INPUT_ID,
  agentId: 'agent-01',
  channelId: 'mobile-ios',
  conversationId: CONVERSATION_ID,
  text: 'Focus on the durable path',
  behavior: 'steer',
  expectedActiveTurnId: RUN_ID,
} as const;

const EVENT_FRAME = {
  type: 'event',
  id: 'turn-01',
  conversationId: CONVERSATION_ID,
  runId: 'turn-01',
  segmentTurnId: 'turn-01',
  v2Seq: 1,
  event: { type: 'text_delta', text: 'Hello' },
} as const;

const DONE_FRAME = {
  type: 'done',
  id: 'turn-01',
  conversationId: CONVERSATION_ID,
  runId: 'turn-01',
  segmentTurnId: 'turn-01',
  v2Seq: 2,
  outcome: 'completed',
} as const;

const schemaPath = fileURLToPath(
  new URL('../../../contracts/mobile/v2/chat-ws.schema.json', import.meta.url),
);
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schema, 'mobile-v2-chat-ws');
const validateServerFrame = ajv.compile({
  $ref: 'mobile-v2-chat-ws#/$defs/MobileV2WsServerFrame',
});
const validateClientFrame = ajv.compile({
  $ref: 'mobile-v2-chat-ws#/$defs/MobileV2WsClientFrame',
});

function expectSchemaValid(frame: unknown): void {
  expect(
    validateServerFrame(frame),
    ajv.errorsText(validateServerFrame.errors, { separator: '\n' }),
  ).toBe(true);
}

function expectValid(frame: unknown): MobileV2WsClientFrame {
  const result = parseMobileV2ClientFrame(frame);
  expect(result).toEqual({ kind: 'valid', frame });
  if (result.kind !== 'valid') throw new Error('Expected a valid v2 frame');
  return result.frame;
}

function expectRejectable(frame: unknown, expected: { id: string; conversationId?: string }): void {
  const result = parseMobileV2ClientFrame(frame);
  expect(result).toMatchObject({
    kind: 'rejectable',
    id: expected.id,
    code: 'validation_failed',
    ...(expected.conversationId === undefined ? {} : { conversationId: expected.conversationId }),
  });
  if (result.kind !== 'rejectable') throw new Error('Expected a rejectable v2 frame');
  if (expected.conversationId === undefined) expect(result).not.toHaveProperty('conversationId');
  expect(result.error.length).toBeGreaterThan(0);
  expect(result.error.length).toBeLessThanOrEqual(160);
}

interface TestSocket {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface CapturedHandlers {
  onOpen?(event: unknown, socket: TestSocket): void;
  onMessage?(event: { data: unknown }, socket: TestSocket): void;
  onClose?(event: unknown, socket: TestSocket): void;
}

function makeHubHarness() {
  const start = vi.fn<ResumableChatHub['start']>();
  const startV2 = vi.fn<ResumableChatHub['startV2']>();
  const resume = vi.fn<ResumableChatHub['resume']>();
  const subscribeConversation = vi.fn<ResumableChatHub['subscribeConversation']>();
  const answer = vi.fn<ResumableChatHub['answer']>().mockResolvedValue(undefined);
  const answerV2 = vi.fn<ResumableChatHub['answerV2']>().mockResolvedValue(undefined);
  const cancel = vi.fn<ResumableChatHub['cancel']>().mockResolvedValue(undefined);
  const cancelV2 = vi.fn<ResumableChatHub['cancelV2']>().mockResolvedValue(undefined);
  const enqueueInput = vi.fn<ResumableChatHub['enqueueInput']>().mockResolvedValue(undefined);
  const editFollowUp = vi.fn<ResumableChatHub['editFollowUp']>().mockResolvedValue(undefined);
  const removeFollowUp = vi.fn<ResumableChatHub['removeFollowUp']>().mockResolvedValue(undefined);
  const resumeFollowUps = vi.fn<ResumableChatHub['resumeFollowUps']>().mockResolvedValue(undefined);
  const resumeRecoveredQueues = vi
    .fn<ResumableChatHub['resumeRecoveredQueues']>()
    .mockResolvedValue(undefined);
  const suspend = vi.fn<ResumableChatHub['suspend']>().mockResolvedValue(undefined);
  const detach = vi.fn<ResumableChatHub['detach']>();
  const cancelAgent = vi.fn<ResumableChatHub['cancelAgent']>().mockResolvedValue(undefined);
  const allowAgent = vi.fn<ResumableChatHub['allowAgent']>();
  const stop = vi.fn<ResumableChatHub['stop']>().mockResolvedValue(undefined);
  const hub: ResumableChatHub = {
    start,
    startV2,
    resume,
    subscribeConversation,
    answer,
    answerV2,
    cancel,
    cancelV2,
    enqueueInput,
    editFollowUp,
    removeFollowUp,
    resumeFollowUps,
    resumeRecoveredQueues,
    suspend,
    detach,
    cancelAgent,
    allowAgent,
    stop,
  };
  return {
    hub,
    start,
    startV2,
    resume,
    subscribeConversation,
    answer,
    answerV2,
    cancel,
    cancelV2,
    enqueueInput,
    editFollowUp,
    removeFollowUp,
    resumeFollowUps,
    detach,
  };
}

function makeSocket(): TestSocket {
  return { send: vi.fn(), close: vi.fn() };
}

function sentFrames(socket: TestSocket): MobileV2WsServerFrame[] {
  return socket.send.mock.calls.map(
    ([data]) => JSON.parse(data as string) as MobileV2WsServerFrame,
  );
}

function makeWsHarness(options: { verbose?: boolean } = {}) {
  const hub = makeHubHarness();
  const agents = {
    chat: vi.fn(() =>
      (async function* emptyStream() {
        yield* [];
      })(),
    ),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    answerQuestion: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockReturnValue(true),
  } as unknown as AgentChatCoordinator;
  let createEvents:
    | ((context: {
        req: {
          query(name: string): string | undefined;
          header(name: string): string | undefined;
        };
      }) => CapturedHandlers)
    | undefined;
  const upgradeWebSocket = ((factory: typeof createEvents) => {
    createEvents = factory;
    return () => new Response(null, { status: 200 });
  }) as unknown as UpgradeWebSocket;
  const app = new Hono();
  mountChatWs(app, {
    agents,
    resumableChatHub: hub.hub,
    upgradeWebSocket,
    verbose: options.verbose,
  });

  return {
    hub,
    agents,
    connect() {
      if (!createEvents) throw new Error('WebSocket handler was not mounted');
      const handlers = createEvents({
        req: { query: () => undefined, header: () => undefined },
      });
      const socket = makeSocket();
      handlers.onOpen?.({}, socket);
      return { handlers, socket };
    },
  };
}

function dispatch(
  connection: { handlers: CapturedHandlers; socket: TestSocket },
  frame: unknown,
): void {
  connection.handlers.onMessage?.({ data: JSON.stringify(frame) }, connection.socket);
}

function dispatchRaw(
  connection: { handlers: CapturedHandlers; socket: TestSocket },
  raw: string,
): void {
  connection.handlers.onMessage?.({ data: raw }, connection.socket);
}

function hubDispatchCount(hub: ReturnType<typeof makeHubHarness>): number {
  return [
    hub.start,
    hub.startV2,
    hub.resume,
    hub.subscribeConversation,
    hub.answer,
    hub.answerV2,
    hub.cancel,
    hub.cancelV2,
    hub.enqueueInput,
    hub.editFollowUp,
    hub.removeFollowUp,
    hub.resumeFollowUps,
  ].reduce((count, mock) => count + mock.mock.calls.length, 0);
}

describe('parseMobileV2ClientFrame', () => {
  it('accepts every command discriminant with strict canonical fields', () => {
    const commands: unknown[] = [
      HELLO,
      SUBSCRIBE,
      MESSAGE,
      ENQUEUE_STEER,
      {
        type: 'enqueue_input',
        id: '10000000-0000-4000-8000-000000000003',
        inputId: '20000000-0000-4000-8000-000000000002',
        agentId: 'agent-01',
        channelId: 'mobile-ios',
        conversationId: CONVERSATION_ID,
        text: 'Later',
        behavior: 'followUp',
      },
      {
        type: 'edit_follow_up',
        id: '10000000-0000-4000-8000-000000000004',
        conversationId: CONVERSATION_ID,
        inputId: INPUT_ID,
        expectedRevision: 0,
        text: 'Replacement',
      },
      {
        type: 'remove_follow_up',
        id: '10000000-0000-4000-8000-000000000005',
        conversationId: CONVERSATION_ID,
        inputId: INPUT_ID,
        expectedRevision: 1,
      },
      {
        type: 'resume_follow_ups',
        id: '10000000-0000-4000-8000-000000000006',
        conversationId: CONVERSATION_ID,
        expectedQueueRevision: 2,
      },
      { type: 'answer', id: 'turn-01', questionId: 'question-01', answer: 'Yes' },
      { type: 'cancel', id: 'turn-01' },
    ];

    for (const command of commands) expectValid(command);
  });

  it('treats a missing or invalid required reply correlation as fatal', () => {
    const fatal: unknown[] = [
      null,
      [],
      { type: 'future_command', id: COMMAND_ID },
      { type: 'subscribe_conversation', agentId: 'agent-01' },
      { ...SUBSCRIBE, id: 'turn-01' },
      { ...MESSAGE, id: '' },
      { ...MESSAGE, id: ' \t\r\n' },
      { ...MESSAGE, id: 'a'.repeat(257) },
      { ...ENQUEUE_STEER, id: 'turn-01' },
      { ...ENQUEUE_STEER, id: 'bad', commandId: COMMAND_ID },
      { type: 'enqueue_input', inputId: COMMAND_ID, nested: { id: COMMAND_ID } },
      { type: 'answer', id: '', questionId: 'question-01', answer: 'Yes' },
      { type: 'cancel', id: ' \t\r\n' },
    ];

    for (const frame of fatal) {
      expect(parseMobileV2ClientFrame(frame)).toEqual({
        kind: 'fatal',
        reason: 'invalid_frame',
      });
    }
  });

  it('rejects command bodies only after preserving a valid top-level reply ID', () => {
    const cases: Array<{ frame: unknown; conversationId?: string }> = [
      { frame: { ...SUBSCRIBE, conversationId: 'not-a-uuid' } },
      {
        frame: { ...SUBSCRIBE, sinceV2Seq: Number.MAX_SAFE_INTEGER + 1 },
        conversationId: CONVERSATION_ID,
      },
      { frame: { ...MESSAGE, conversationId: 'not-a-uuid' } },
      { frame: { ...MESSAGE, streamingBehavior: 'steer' }, conversationId: CONVERSATION_ID },
      { frame: { ...ENQUEUE_STEER, inputId: 'not-a-uuid' }, conversationId: CONVERSATION_ID },
      {
        frame: { ...ENQUEUE_STEER, expectedActiveTurnId: undefined },
        conversationId: CONVERSATION_ID,
      },
      {
        frame: {
          ...ENQUEUE_STEER,
          behavior: 'followUp',
          expectedActiveTurnId: RUN_ID,
        },
        conversationId: CONVERSATION_ID,
      },
      {
        frame: {
          type: 'edit_follow_up',
          id: COMMAND_ID,
          conversationId: CONVERSATION_ID,
          inputId: INPUT_ID,
          expectedRevision: -1,
          text: 'Replacement',
        },
        conversationId: CONVERSATION_ID,
      },
      {
        frame: {
          type: 'remove_follow_up',
          id: COMMAND_ID,
          conversationId: CONVERSATION_ID,
          inputId: INPUT_ID,
          expectedRevision: Number.MAX_SAFE_INTEGER + 1,
        },
        conversationId: CONVERSATION_ID,
      },
      {
        frame: {
          type: 'resume_follow_ups',
          id: COMMAND_ID,
          conversationId: CONVERSATION_ID,
          expectedQueueRevision: 1.5,
        },
        conversationId: CONVERSATION_ID,
      },
      {
        frame: { type: 'answer', id: 'turn-01', questionId: '', answer: 'Yes' },
      },
      { frame: { type: 'cancel', id: 'turn-01', extra: 'secret' } },
    ];

    for (const { frame, conversationId } of cases) {
      const id = (frame as { id: string }).id;
      expectRejectable(frame, { id, conversationId });
    }
  });

  it('keeps canonical outer and nested UUID rules aligned with the WebSocket schema', () => {
    const urnUuid = `urn:uuid:${COMMAND_ID}`;
    const outer = { ...SUBSCRIBE, id: urnUuid };
    expect(parseMobileV2ClientFrame(outer)).toEqual({ kind: 'fatal', reason: 'invalid_frame' });
    expect(validateClientFrame(outer), ajv.errorsText(validateClientFrame.errors)).toBe(false);

    const nested = { ...ENQUEUE_STEER, inputId: urnUuid };
    expectRejectable(nested, { id: ENQUEUE_STEER.id, conversationId: CONVERSATION_ID });
    expect(validateClientFrame(nested), ajv.errorsText(validateClientFrame.errors)).toBe(false);
  });

  it('uses one 256-byte legacy-run rule for message, answer, cancel, and Steer targets', () => {
    const accepted = ['a'.repeat(256), '🚀'.repeat(64), '\u00a0', ' turn-01 '];
    const rejected = ['a'.repeat(257), `${'🚀'.repeat(64)}a`, ' \t\r\n'];

    for (const id of accepted) {
      expectValid({ ...MESSAGE, id });
      expectValid({ type: 'answer', id, questionId: 'question-01', answer: 'Yes' });
      expectValid({ type: 'cancel', id });
      expectValid({ ...ENQUEUE_STEER, expectedActiveTurnId: id });
    }
    for (const id of rejected) {
      expect(parseMobileV2ClientFrame({ ...MESSAGE, id }).kind).toBe('fatal');
      expect(
        parseMobileV2ClientFrame({ type: 'answer', id, questionId: 'question-01', answer: 'Yes' })
          .kind,
      ).toBe('fatal');
      expect(parseMobileV2ClientFrame({ type: 'cancel', id }).kind).toBe('fatal');
      expectRejectable(
        { ...ENQUEUE_STEER, expectedActiveTurnId: id },
        { id: ENQUEUE_STEER.id, conversationId: CONVERSATION_ID },
      );
    }
  });

  it('enforces canonical base64 plus exact per-image and per-frame decoded limits', () => {
    const oneByte = { mediaType: 'image/png', data: 'YQ==' };
    expectValid({ ...MESSAGE, images: [oneByte] });

    for (const data of ['', 'YQ', 'YR==', 'Zh==', 'Zm9=', 'YQ==\n', 'YQ-_']) {
      expectRejectable(
        { ...MESSAGE, images: [{ mediaType: 'image/png', data }] },
        { id: MESSAGE.id, conversationId: CONVERSATION_ID },
      );
    }
    expectRejectable(
      { ...MESSAGE, images: [{ ...oneByte, privateKey: 'do-not-log' }] },
      { id: MESSAGE.id, conversationId: CONVERSATION_ID },
    );
    expectRejectable(
      { ...MESSAGE, images: Array.from({ length: 5 }, () => oneByte) },
      { id: MESSAGE.id, conversationId: CONVERSATION_ID },
    );

    const fiveMiB = Buffer.alloc(5 * 1024 * 1024).toString('base64');
    const overFiveMiB = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
    expectValid({ ...MESSAGE, images: [{ mediaType: 'image/png', data: fiveMiB }] });
    expectRejectable(
      { ...MESSAGE, images: [{ mediaType: 'image/png', data: overFiveMiB }] },
      { id: MESSAGE.id, conversationId: CONVERSATION_ID },
    );

    const fourMiB = Buffer.alloc(4 * 1024 * 1024).toString('base64');
    const overFourMiB = Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64');
    expectValid({
      ...MESSAGE,
      images: Array.from({ length: 3 }, () => ({ mediaType: 'image/png', data: fourMiB })),
    });
    expectRejectable(
      {
        ...MESSAGE,
        images: [
          { mediaType: 'image/png', data: fourMiB },
          { mediaType: 'image/png', data: fourMiB },
          { mediaType: 'image/png', data: overFourMiB },
        ],
      },
      { id: MESSAGE.id, conversationId: CONVERSATION_ID },
    );
  });

  it('strictly validates v2 location bounds, nested keys, and RFC 3339 timestamps', () => {
    const location = {
      timezone: 'Asia/Singapore',
      utcOffsetMinutes: 480,
      locale: 'en-SG',
      region: 'SG',
      precise: {
        latitude: 1.29,
        longitude: 103.85,
        accuracyMeters: 12,
        capturedAt: '2026-09-06T01:02:03.456+08:00',
        place: 'Singapore',
      },
    };
    expectValid({ ...MESSAGE, location });
    expectValid({ ...MESSAGE, location: { ...location, timezone: '🚀'.repeat(200) } });
    for (const capturedAt of [
      '2026-09-06t01:02:03z',
      '1990-12-31T23:59:60Z',
      '2026-09-06T01:02:03+23:59',
    ]) {
      expectValid({
        ...MESSAGE,
        location: { ...location, precise: { ...location.precise, capturedAt } },
      });
    }

    const invalidLocations: unknown[] = [
      { ...location, timezone: '' },
      { ...location, timezone: '🚀'.repeat(201) },
      { ...location, locale: 'a'.repeat(201) },
      { ...location, utcOffsetMinutes: -841 },
      { ...location, utcOffsetMinutes: 1.5 },
      { ...location, region: 'SGP' },
      { ...location, privateKey: 'secret' },
      { ...location, precise: { ...location.precise, latitude: 91 } },
      { ...location, precise: { ...location.precise, latitude: Number.NaN } },
      { ...location, precise: { ...location.precise, longitude: -181 } },
      { ...location, precise: { ...location.precise, longitude: Number.POSITIVE_INFINITY } },
      { ...location, precise: { ...location.precise, accuracyMeters: 1.5 } },
      {
        ...location,
        precise: { ...location.precise, accuracyMeters: Number.MAX_SAFE_INTEGER + 1 },
      },
      { ...location, precise: { ...location.precise, capturedAt: '2026-02-30T01:02:03Z' } },
      { ...location, precise: { ...location.precise, capturedAt: '2026-09-06 01:02:03' } },
      { ...location, precise: { ...location.precise, place: '' } },
      { ...location, precise: { ...location.precise, secretCoordinate: 42 } },
    ];
    for (const invalid of invalidLocations) {
      expectRejectable(
        { ...MESSAGE, location: invalid },
        { id: MESSAGE.id, conversationId: CONVERSATION_ID },
      );
    }
  });

  it('matches the contract date-time format for valid and misplaced leap seconds', () => {
    const location = {
      timezone: 'Etc/UTC',
      utcOffsetMinutes: 0,
      locale: 'en',
      precise: {
        latitude: 0,
        longitude: 0,
        accuracyMeters: 0,
        capturedAt: '1990-12-31T23:59:60Z',
      },
    };
    const valid = { ...MESSAGE, location };
    expect(validateClientFrame(valid), ajv.errorsText(validateClientFrame.errors)).toBe(true);
    expectValid(valid);

    const misplaced = {
      ...MESSAGE,
      location: {
        ...location,
        precise: { ...location.precise, capturedAt: '2026-09-06T01:02:60Z' },
      },
    };
    expect(validateClientFrame(misplaced), ajv.errorsText(validateClientFrame.errors)).toBe(false);
    expectRejectable(misplaced, { id: MESSAGE.id, conversationId: CONVERSATION_ID });
  });

  it.each([
    ['space separator', '2026-09-06 01:02:03Z'],
    ['newline separator', '2026-09-06\n01:02:03Z'],
    ['tab separator', '2026-09-06\t01:02:03Z'],
    ['offset without minutes', '2026-09-06T01:02:03+08'],
    ['offset without a colon', '2026-09-06T01:02:03+0800'],
  ])('aligns the capturedAt schema against the strict RFC 3339 $label', (_label, capturedAt) => {
    const frame = {
      ...MESSAGE,
      location: {
        timezone: 'Etc/UTC',
        utcOffsetMinutes: 0,
        locale: 'en',
        precise: {
          latitude: 0,
          longitude: 0,
          accuracyMeters: 0,
          capturedAt,
        },
      },
    };
    expectRejectable(frame, { id: MESSAGE.id, conversationId: CONVERSATION_ID });
    expect(validateClientFrame(frame), ajv.errorsText(validateClientFrame.errors)).toBe(false);
  });

  it('keeps nonnegative safe-integer accuracy aligned between the parser and schema', () => {
    const location = {
      timezone: 'Etc/UTC',
      utcOffsetMinutes: 0,
      locale: 'en',
      precise: {
        latitude: 0,
        longitude: 0,
        accuracyMeters: 0,
        capturedAt: '2026-09-06T01:02:03Z',
      },
    };
    for (const accuracyMeters of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const frame = {
        ...MESSAGE,
        location: {
          ...location,
          precise: { ...location.precise, accuracyMeters },
        },
      };
      expectRejectable(frame, { id: MESSAGE.id, conversationId: CONVERSATION_ID });
      expect(validateClientFrame(frame), ajv.errorsText(validateClientFrame.errors)).toBe(false);
    }
  });

  it('keeps nonempty precise place aligned between the parser and schema', () => {
    const frame = {
      ...MESSAGE,
      location: {
        timezone: 'Etc/UTC',
        utcOffsetMinutes: 0,
        locale: 'en',
        precise: {
          latitude: 0,
          longitude: 0,
          accuracyMeters: 0,
          capturedAt: '2026-09-06T01:02:03Z',
          place: '',
        },
      },
    };
    expectRejectable(frame, { id: MESSAGE.id, conversationId: CONVERSATION_ID });
    expect(validateClientFrame(frame), ajv.errorsText(validateClientFrame.errors)).toBe(false);
  });

  it('rejects oversized location strings before allocating code-point arrays', () => {
    const from = vi.spyOn(Array, 'from');
    const oversizedTimezone = 't'.repeat(401);
    const oversizedPlace = 'p'.repeat(401);
    try {
      expectRejectable(
        {
          ...MESSAGE,
          location: { timezone: oversizedTimezone, utcOffsetMinutes: 0, locale: 'en' },
        },
        { id: MESSAGE.id, conversationId: CONVERSATION_ID },
      );
      expectRejectable(
        {
          ...MESSAGE,
          location: {
            timezone: 'Etc/UTC',
            utcOffsetMinutes: 0,
            locale: 'en',
            precise: {
              latitude: 0,
              longitude: 0,
              accuracyMeters: 0,
              capturedAt: '2026-09-06T01:02:03Z',
              place: oversizedPlace,
            },
          },
        },
        { id: MESSAGE.id, conversationId: CONVERSATION_ID },
      );
      expect(
        from.mock.calls.some(([value]) => value === oversizedTimezone || value === oversizedPlace),
      ).toBe(false);
    } finally {
      from.mockRestore();
    }
  });

  it('returns bounded errors that never echo invalid fields or user content', () => {
    const secret = 'private prompt and credential';
    const frame = {
      ...ENQUEUE_STEER,
      text: secret,
      unknownSecretKey: secret,
    };
    const result = parseMobileV2ClientFrame(frame);
    expect(result.kind).toBe('rejectable');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('unknownSecretKey');
  });

  it('never echoes branch-foreign conversation IDs from answer or cancel frames', () => {
    for (const frame of [
      {
        type: 'answer',
        id: 'turn-01',
        questionId: '',
        answer: 'Yes',
        conversationId: CONVERSATION_ID,
      },
      { type: 'cancel', id: 'turn-01', conversationId: CONVERSATION_ID },
    ]) {
      const result = parseMobileV2ClientFrame(frame);
      expect(result).toMatchObject({ kind: 'rejectable', id: 'turn-01' });
      expect(result).not.toHaveProperty('conversationId');
    }
  });
});

describe('summarizeMobileV2Inbound', () => {
  it('allowlists structural metadata without logging content, coordinates, or unknown keys', () => {
    const secret = 'private prompt token credential';
    const value = {
      ...ENQUEUE_STEER,
      text: secret,
      images: [{ mediaType: 'image/png', data: 'cHJpdmF0ZS1pbWFnZQ==' }],
      location: {
        timezone: 'Asia/Singapore',
        utcOffsetMinutes: 480,
        locale: 'en-SG',
        precise: {
          latitude: 1.2966,
          longitude: 103.7764,
          accuracyMeters: 12,
          capturedAt: '2026-09-06T01:02:03Z',
          place: 'Private place',
        },
      },
      privateCredentialKey: secret,
      nestedSecret: { value: secret },
    };
    const raw = JSON.stringify(value);
    const summary = summarizeMobileV2Inbound(raw, value);
    const serialized = JSON.stringify(summary);

    expect(summary).toMatchObject({
      frameType: 'enqueue_input',
      byteLength: Buffer.byteLength(raw),
      imageCount: 1,
    });
    expect(serialized).toContain('recognizedKeys');
    for (const forbidden of [
      secret,
      'privateCredentialKey',
      'nestedSecret',
      'Asia/Singapore',
      '1.2966',
      '103.7764',
      'Private place',
      'cHJpdmF0ZS1pbWFnZQ==',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('reports only UTF-8 raw size for malformed or unknown input', () => {
    const malformedRaw = '🚀 private malformed payload';
    expect(summarizeMobileV2Inbound(malformedRaw, null)).toEqual({
      byteLength: Buffer.byteLength(malformedRaw),
    });

    const unknown = {
      type: 'private_future_command',
      privateToken: 'secret',
      nested: { privateError: 'raw provider error' },
    };
    const raw = JSON.stringify(unknown);
    expect(summarizeMobileV2Inbound(raw, unknown)).toEqual({
      byteLength: Buffer.byteLength(raw),
    });
  });
});

describe('mountChatWs v2 protocol negotiation', () => {
  it('negotiates capabilities, replays, and acknowledges one conversation subscription', () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    harness.hub.subscribeConversation.mockImplementationOnce((frame, sink) => {
      sink.send(EVENT_FRAME);
      sink.send({
        type: 'conversation_subscribed',
        id: frame.id,
        conversationId: frame.conversationId,
        v2ThroughSeq: EVENT_FRAME.v2Seq,
      });
    });

    dispatch(connection, {
      ...HELLO,
      capabilities: ['future-capability', 'chat-input-queue-v1'],
    });
    dispatch(connection, SUBSCRIBE);

    expect(sentFrames(connection.socket)).toEqual([
      {
        type: 'hello_ack',
        contractVersion: 2,
        capabilities: ['chat-input-queue-v1'],
      },
      EVENT_FRAME,
      {
        type: 'conversation_subscribed',
        id: SUBSCRIBE.id,
        conversationId: CONVERSATION_ID,
        v2ThroughSeq: 1,
      },
    ]);
    for (const frame of sentFrames(connection.socket)) expectSchemaValid(frame);
    expect(harness.hub.subscribeConversation).toHaveBeenCalledOnce();
    expect(connection.socket.close).not.toHaveBeenCalled();
  });

  it('binds v2 before sending hello_ack so a reentrant subscription stays v2', () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    connection.socket.send.mockImplementationOnce(() => dispatch(connection, SUBSCRIBE));

    dispatch(connection, HELLO);

    expect(harness.hub.subscribeConversation).toHaveBeenCalledOnce();
    expect(connection.socket.close).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'unsupported first hello',
      first: { type: 'hello', contractVersion: 1, capabilities: [] },
      reason: 'unsupported_version',
    },
    {
      name: 'first hello with a missing version',
      first: { type: 'hello', capabilities: [] },
      reason: 'unsupported_version',
    },
    {
      name: 'first hello with string version 2',
      first: { type: 'hello', contractVersion: '2', capabilities: [] },
      reason: 'unsupported_version',
    },
    {
      name: 'supported hello with malformed capabilities',
      first: { type: 'hello', contractVersion: 2, capabilities: 'queue' },
      reason: 'invalid_frame',
    },
    {
      name: 'supported hello with duplicate capabilities',
      first: {
        type: 'hello',
        contractVersion: 2,
        capabilities: ['chat-input-queue-v1', 'chat-input-queue-v1'],
      },
      reason: 'invalid_frame',
    },
    {
      name: 'supported hello with an extra field',
      first: { ...HELLO, token: 'private-token' },
      reason: 'invalid_frame',
    },
    {
      name: 'v2-only command before hello even with an invalid correlation',
      first: { type: 'enqueue_input', id: 'not-a-uuid' },
      reason: 'hello_required',
    },
  ])('closes $name without a JSON frame or hub race', ({ first, reason }) => {
    const harness = makeWsHarness();
    const connection = harness.connect();

    dispatch(connection, first);
    dispatch(connection, MESSAGE);

    expect(connection.socket.close).toHaveBeenCalledOnce();
    expect(connection.socket.close).toHaveBeenCalledWith(1002, reason);
    expect(sentFrames(connection.socket)).toEqual([]);
    expect(hubDispatchCount(harness.hub)).toBe(0);
  });

  it('closes a late hello as unexpected and cannot upgrade the socket', () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    dispatch(connection, HELLO);
    connection.socket.send.mockClear();

    dispatch(connection, HELLO);
    dispatch(connection, SUBSCRIBE);

    expect(connection.socket.close).toHaveBeenCalledWith(1002, 'unexpected_hello');
    expect(sentFrames(connection.socket)).toEqual([]);
    expect(hubDispatchCount(harness.hub)).toBe(0);
  });

  it.each([
    { frame: { ...SUBSCRIBE, id: 'not-a-uuid' }, label: 'subscription UUID' },
    { frame: { ...MESSAGE, id: ' \t\r\n' }, label: 'ordinary run correlation' },
    { frame: { type: 'cancel', id: '' }, label: 'cancel correlation' },
    { frame: { type: 'resume', id: RUN_ID }, label: 'v1-only resume discriminant' },
  ])('closes invalid established-v2 $label without inventing a reply', ({ frame }) => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    dispatch(connection, HELLO);
    connection.socket.send.mockClear();

    dispatch(connection, frame);

    expect(connection.socket.close).toHaveBeenCalledWith(1002, 'invalid_frame');
    expect(sentFrames(connection.socket)).toEqual([]);
    expect(hubDispatchCount(harness.hub)).toBe(0);
  });

  it.each([
    { data: 'not-json', label: 'malformed JSON' },
    { data: new Uint8Array([1, 2, 3]), label: 'binary input' },
  ])('closes established v2 on $label', ({ data }) => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    dispatch(connection, HELLO);
    connection.socket.send.mockClear();

    connection.handlers.onMessage?.({ data }, connection.socket);

    expect(connection.socket.close).toHaveBeenCalledWith(1002, 'invalid_frame');
    expect(sentFrames(connection.socket)).toEqual([]);
  });

  it.each([
    { first: 'not-json', label: 'malformed JSON' },
    { first: JSON.stringify({ type: 'message', id: 'turn-01' }), label: 'malformed shared frame' },
  ])('latches $label to v1 before its legacy error, then rejects a late hello', ({ first }) => {
    const harness = makeWsHarness();
    const connection = harness.connect();

    dispatchRaw(connection, first);
    expect(sentFrames(connection.socket)[0]).toMatchObject({ type: 'error' });
    connection.socket.send.mockClear();
    dispatch(connection, HELLO);

    expect(connection.socket.close).toHaveBeenCalledWith(1002, 'unexpected_hello');
    expect(sentFrames(connection.socket)).toEqual([]);
  });

  it('keeps v2-only commands on the legacy validation path after v1 latches', () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    dispatch(connection, { ...MESSAGE, id: 'turn-01', conversationId: 'conversation-01' });
    expect(harness.hub.start).toHaveBeenCalledOnce();
    connection.socket.send.mockClear();

    dispatch(connection, { type: 'enqueue_input', id: COMMAND_ID });

    expect(sentFrames(connection.socket)).toEqual([
      {
        type: 'error',
        id: COMMAND_ID,
        error: 'Invalid message: missing required fields',
        code: 'validation_failed',
        retryable: false,
      },
    ]);
    expect(connection.socket.close).not.toHaveBeenCalled();
    expect(harness.hub.enqueueInput).not.toHaveBeenCalled();
  });

  it('preserves opaque IDs and unknown fields for a v1 first frame', () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    const v1 = {
      ...MESSAGE,
      id: 'turn-01',
      conversationId: 'legacy-conversation',
      unknownFutureField: 'preserve-v1-permissiveness',
    };

    dispatch(connection, v1);

    expect(harness.hub.start).toHaveBeenCalledWith(v1, expect.any(Object));
    expect(harness.hub.startV2).not.toHaveBeenCalled();
  });
});

describe('mountChatWs v2 validation and dispatch', () => {
  it.each([
    { frame: { ...SUBSCRIBE, conversationId: 'bad' }, correlation: SUBSCRIBE.id },
    { frame: { ...SUBSCRIBE, sinceV2Seq: -1 }, correlation: SUBSCRIBE.id },
    { frame: { ...MESSAGE, conversationId: 'bad' }, correlation: MESSAGE.id },
    { frame: { ...MESSAGE, streamingBehavior: 'steer' }, correlation: MESSAGE.id },
    { frame: { ...ENQUEUE_STEER, inputId: 'bad' }, correlation: ENQUEUE_STEER.id },
    {
      frame: { ...ENQUEUE_STEER, expectedActiveTurnId: undefined },
      correlation: ENQUEUE_STEER.id,
    },
    {
      frame: {
        type: 'edit_follow_up',
        id: COMMAND_ID,
        conversationId: CONVERSATION_ID,
        inputId: INPUT_ID,
        expectedRevision: -1,
        text: 'Edit',
      },
      correlation: COMMAND_ID,
    },
    {
      frame: {
        type: 'remove_follow_up',
        id: COMMAND_ID,
        conversationId: CONVERSATION_ID,
        inputId: 'bad',
        expectedRevision: 1,
      },
      correlation: COMMAND_ID,
    },
    {
      frame: {
        type: 'resume_follow_ups',
        id: COMMAND_ID,
        conversationId: CONVERSATION_ID,
        expectedQueueRevision: Number.MAX_SAFE_INTEGER + 1,
      },
      correlation: COMMAND_ID,
    },
    {
      frame: { type: 'answer', id: RUN_ID, questionId: '', answer: 'Yes' },
      correlation: RUN_ID,
    },
  ])('rejects malformed correlated commands without disconnecting', ({ frame, correlation }) => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    dispatch(connection, HELLO);
    connection.socket.send.mockClear();

    dispatch(connection, frame);

    const frames = sentFrames(connection.socket);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'command_rejected',
      id: correlation,
      code: 'validation_failed',
      retryable: false,
    });
    expectSchemaValid(frames[0]);
    expect(connection.socket.close).not.toHaveBeenCalled();
    expect(hubDispatchCount(harness.hub)).toBe(0);
  });

  it('stays usable after a rejected mutation and delivers a later valid event', async () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    harness.hub.startV2.mockImplementationOnce((_frame, sink) => sink.send(EVENT_FRAME));
    dispatch(connection, HELLO);
    dispatch(connection, { ...ENQUEUE_STEER, inputId: 'bad' });
    dispatch(connection, MESSAGE);

    await vi.waitFor(() => expect(harness.hub.startV2).toHaveBeenCalledOnce());
    const frames = sentFrames(connection.socket);
    expect(frames.map((frame) => frame.type)).toEqual(['hello_ack', 'command_rejected', 'event']);
    for (const frame of frames) expectSchemaValid(frame);
    expect(connection.socket.close).not.toHaveBeenCalled();
  });

  it('dispatches every valid v2 command through the canonical hub and one stable sink', async () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    const edit = {
      type: 'edit_follow_up',
      id: '10000000-0000-4000-8000-000000000003',
      conversationId: CONVERSATION_ID,
      inputId: INPUT_ID,
      expectedRevision: 1,
      text: 'Edited',
    } as const;
    const remove = {
      type: 'remove_follow_up',
      id: '10000000-0000-4000-8000-000000000004',
      conversationId: CONVERSATION_ID,
      inputId: INPUT_ID,
      expectedRevision: 2,
    } as const;
    const resume = {
      type: 'resume_follow_ups',
      id: '10000000-0000-4000-8000-000000000005',
      conversationId: CONVERSATION_ID,
      expectedQueueRevision: 3,
    } as const;
    const answer = {
      type: 'answer',
      id: RUN_ID,
      questionId: 'question-01',
      answer: 'Yes',
    } as const;
    const cancel = { type: 'cancel', id: RUN_ID } as const;

    dispatch(connection, HELLO);
    for (const frame of [SUBSCRIBE, MESSAGE, ENQUEUE_STEER, edit, remove, resume, answer, cancel]) {
      dispatch(connection, frame);
    }

    await vi.waitFor(() => expect(harness.hub.cancelV2).toHaveBeenCalledOnce());
    expect(harness.hub.subscribeConversation).toHaveBeenCalledOnce();
    expect(harness.hub.startV2).toHaveBeenCalledOnce();
    expect(harness.hub.enqueueInput).toHaveBeenCalledOnce();
    expect(harness.hub.editFollowUp).toHaveBeenCalledOnce();
    expect(harness.hub.removeFollowUp).toHaveBeenCalledOnce();
    expect(harness.hub.resumeFollowUps).toHaveBeenCalledOnce();
    expect(harness.hub.answerV2).toHaveBeenCalledOnce();
    expect(harness.hub.cancelV2).toHaveBeenCalledOnce();
    expect(harness.hub.start).not.toHaveBeenCalled();
    expect(harness.hub.answer).not.toHaveBeenCalled();
    expect(harness.hub.cancel).not.toHaveBeenCalled();

    const sinks = [
      harness.hub.subscribeConversation.mock.calls[0]?.[1],
      harness.hub.startV2.mock.calls[0]?.[1],
      harness.hub.enqueueInput.mock.calls[0]?.[1],
      harness.hub.editFollowUp.mock.calls[0]?.[1],
      harness.hub.removeFollowUp.mock.calls[0]?.[1],
      harness.hub.resumeFollowUps.mock.calls[0]?.[1],
      harness.hub.answerV2.mock.calls[0]?.[1],
      harness.hub.cancelV2.mock.calls[0]?.[1],
    ];
    expect(new Set(sinks).size).toBe(1);
  });

  it('maps domain errors to schema-valid nonterminal command_rejected details', () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    harness.hub.startV2.mockImplementationOnce(() => {
      throw new ConversationServiceError(
        'conversation_busy',
        'Conversation has an active turn',
        409,
        false,
        { activeTurnId: 'turn-02' },
      );
    });
    dispatch(connection, HELLO);
    connection.socket.send.mockClear();

    dispatch(connection, MESSAGE);

    const frame = sentFrames(connection.socket)[0];
    expect(frame).toEqual({
      type: 'command_rejected',
      id: MESSAGE.id,
      conversationId: CONVERSATION_ID,
      code: 'conversation_busy',
      error: 'Conversation has an active turn',
      retryable: false,
      details: { activeTurnId: 'turn-02' },
    });
    expect(frame).not.toHaveProperty('activeTurnId');
    expectSchemaValid(frame);
    expect(connection.socket.close).not.toHaveBeenCalled();
  });

  it('echoes opaque answer/cancel IDs on hub rejection and keeps the socket open', async () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    harness.hub.answerV2.mockRejectedValueOnce(
      new ConversationServiceError('not_found', 'Run not found', 404, false),
    );
    harness.hub.cancelV2.mockRejectedValueOnce(
      new ConversationServiceError('not_found', 'Run not found', 404, false),
    );
    dispatch(connection, HELLO);
    connection.socket.send.mockClear();

    dispatch(connection, {
      type: 'answer',
      id: 'turn-01',
      questionId: 'question-01',
      answer: 'Yes',
    });
    dispatch(connection, { type: 'cancel', id: 'turn-01' });

    await vi.waitFor(() => expect(sentFrames(connection.socket)).toHaveLength(2));
    for (const frame of sentFrames(connection.socket)) {
      expect(frame).toMatchObject({
        type: 'command_rejected',
        id: 'turn-01',
        code: 'not_found',
        retryable: false,
      });
      expectSchemaValid(frame);
    }
    expect(connection.socket.close).not.toHaveBeenCalled();
  });

  it('sanitizes unknown thrown errors as nonterminal gateway_offline rejections', async () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    harness.hub.enqueueInput.mockRejectedValueOnce(new Error('private raw provider failure'));
    dispatch(connection, HELLO);
    connection.socket.send.mockClear();

    dispatch(connection, ENQUEUE_STEER);

    await vi.waitFor(() => expect(sentFrames(connection.socket)).toHaveLength(1));
    const frame = sentFrames(connection.socket)[0];
    expect(frame).toMatchObject({
      type: 'command_rejected',
      id: ENQUEUE_STEER.id,
      conversationId: CONVERSATION_ID,
      code: 'gateway_offline',
      error: 'Internal gateway error',
      retryable: true,
    });
    expect(JSON.stringify(frame)).not.toContain('private raw provider failure');
    expectSchemaValid(frame);
    expect(connection.socket.close).not.toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).toContain('errorMessageLength');
    expect(JSON.stringify(error.mock.calls)).not.toContain('private raw provider failure');
    error.mockRestore();
  });
});

describe('mountChatWs v2 socket lifecycle', () => {
  it('keeps the subscription open across terminal frames and detaches only on socket close', () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    let sink: V2ConversationFrameSink | undefined;
    harness.hub.subscribeConversation.mockImplementationOnce((_frame, value) => {
      sink = value;
    });
    dispatch(connection, HELLO);
    dispatch(connection, SUBSCRIBE);
    connection.socket.send.mockClear();

    sink?.send(DONE_FRAME);

    expect(sentFrames(connection.socket)).toEqual([DONE_FRAME]);
    expectSchemaValid(sentFrames(connection.socket)[0]);
    expect(connection.socket.close).not.toHaveBeenCalled();
    expect(harness.hub.detach).not.toHaveBeenCalled();

    connection.handlers.onClose?.({}, connection.socket);
    expect(harness.hub.detach).toHaveBeenCalledOnce();
    expect(harness.hub.detach).toHaveBeenCalledWith(sink);
    expect(harness.hub.cancelV2).not.toHaveBeenCalled();
    expect(
      (harness.agents as unknown as { cancel: ReturnType<typeof vi.fn> }).cancel,
    ).not.toHaveBeenCalled();

    connection.socket.send.mockClear();
    expect(() => sink?.send(EVENT_FRAME)).toThrow('Chat WebSocket is not open');
    expect(sentFrames(connection.socket)).toEqual([]);
  });

  it('suppresses deferred hub failures and sends after a fatal close', async () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let rejectOperation!: (error: Error) => void;
    const deferred = new Promise<void>((_resolve, reject) => {
      rejectOperation = reject;
    });
    let sink: V2ConversationFrameSink | undefined;
    harness.hub.startV2.mockImplementationOnce((_frame, value) => {
      sink = value;
      return deferred as never;
    });
    dispatch(connection, HELLO);
    connection.socket.send.mockClear();

    dispatch(connection, MESSAGE);
    dispatch(connection, { type: 'cancel', id: '' });
    connection.handlers.onClose?.({}, connection.socket);
    rejectOperation(new Error('private deferred failure'));
    expect(() => sink?.send(EVENT_FRAME)).toThrow('Chat WebSocket is not open');
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.socket.close).toHaveBeenCalledWith(1002, 'invalid_frame');
    expect(sentFrames(connection.socket)).toEqual([]);
    expect(harness.hub.detach).toHaveBeenCalledWith(sink);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('contains a failed command_rejected write from an asynchronously rejected hub call', async () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let rejectOperation!: (error: Error) => void;
    harness.hub.enqueueInput.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOperation = reject;
        }),
    );
    dispatch(connection, HELLO);
    connection.socket.send.mockClear();

    dispatch(connection, ENQUEUE_STEER);
    connection.socket.send.mockImplementationOnce(() => {
      throw new Error('private network write failure');
    });
    rejectOperation(new Error('private deferred hub failure'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.socket.send).toHaveBeenCalledOnce();
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private deferred hub failure');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private network write failure');
    consoleError.mockRestore();
  });

  it('contains a deferred post-close sink failure after the hub operation resolves', async () => {
    const harness = makeWsHarness();
    const connection = harness.connect();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let resolveOperation!: () => void;
    const deferred = new Promise<void>((resolve) => {
      resolveOperation = resolve;
    });
    let sink: V2ConversationFrameSink | undefined;
    harness.hub.startV2.mockImplementationOnce((_frame, value) => {
      sink = value;
      return deferred.then(() => value.send(EVENT_FRAME)) as never;
    });
    dispatch(connection, HELLO);
    connection.socket.send.mockClear();

    dispatch(connection, MESSAGE);
    dispatch(connection, { type: 'cancel', id: '' });
    connection.handlers.onClose?.({}, connection.socket);
    resolveOperation();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.socket.close).toHaveBeenCalledWith(1002, 'invalid_frame');
    expect(sentFrames(connection.socket)).toEqual([]);
    expect(harness.hub.detach).toHaveBeenCalledWith(sink);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
