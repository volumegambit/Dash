import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import {
  CHAT_INPUT_QUEUE_CAPABILITY,
  MOBILE_V2_CONTRACT_VERSION,
  MOBILE_V2_LEGACY_RUN_ID_MAX_UTF8_BYTES,
  type MobileV2ControlFrame,
  type MobileV2SequencedFrame,
  type MobileV2WsServerFrame,
  isMobileV2LegacyRunId,
} from './index.js';

interface FixtureCase {
  file: string;
  document: 'openapi' | 'chat-ws';
  schema: string;
  valid: boolean;
  format?: 'json' | 'jsonl';
}

interface FixtureManifest {
  version: number;
  cases: FixtureCase[];
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function fixture<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(join(root, 'fixtures', file), 'utf8')) as T;
}

async function readOpenApi(): Promise<{
  servers?: Array<{ url: string }>;
  paths?: Record<string, { get?: unknown }>;
}> {
  return parse(await readFile(join(root, 'openapi.yaml'), 'utf8'));
}

async function validateWsFixture(file: string): Promise<boolean> {
  const schema = JSON.parse(await readFile(join(root, 'chat-ws.schema.json'), 'utf8')) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema, 'mobile-v2-chat-ws');
  const validate = ajv.compile({ $ref: 'mobile-v2-chat-ws#/$defs/MobileV2WsFrame' });
  return validate(await fixture(file));
}

async function validateWsValue(schemaName: string, value: unknown): Promise<boolean> {
  const schema = JSON.parse(await readFile(join(root, 'chat-ws.schema.json'), 'utf8')) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema, 'mobile-v2-chat-ws');
  const validate = ajv.compile({ $ref: `mobile-v2-chat-ws#/$defs/${schemaName}` });
  return validate(value);
}

async function validateOpenApiValue(schemaName: string, value: unknown): Promise<boolean> {
  const schema = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema, 'mobile-v2-openapi');
  const validate = ajv.compile({ $ref: `mobile-v2-openapi#/components/schemas/${schemaName}` });
  return validate(value);
}

function resolveLocalRef(document: unknown, ref: string): unknown {
  let value = document;
  for (const component of ref.slice(2).split('/')) {
    value = (value as Record<string, unknown>)[
      component.replaceAll('~1', '/').replaceAll('~0', '~')
    ];
  }
  return value;
}

function collectLocalRefs(value: unknown, output: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectLocalRefs(item, output);
    return output;
  }
  if (typeof value !== 'object' || value === null) return output;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === 'string' && record.$ref.startsWith('#/')) output.push(record.$ref);
  for (const nested of Object.values(record)) collectLocalRefs(nested, output);
  return output;
}

async function listFixtureFiles(dir: string, prefix = ''): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      output.push(...(await listFixtureFiles(join(dir, entry.name), relative)));
    } else if (relative !== 'manifest.json') {
      output.push(relative);
    }
  }
  return output.sort();
}

describe('mobile v2 contract', () => {
  it('exports the v2 contract version and queue capability', () => {
    expect(MOBILE_V2_CONTRACT_VERSION).toBe(2);
    expect(CHAT_INPUT_QUEUE_CAPABILITY).toBe('chat-input-queue-v1');
  });

  it('exports one browser-safe 256-byte validator for inherited run correlations', () => {
    expect(MOBILE_V2_LEGACY_RUN_ID_MAX_UTF8_BYTES).toBe(256);

    const asciiAtLimit = 'a'.repeat(256);
    const asciiOverLimit = 'a'.repeat(257);
    const multibyteAtLimit = '🚀'.repeat(64);
    const multibyteOverLimit = `${multibyteAtLimit}a`;
    const acceptedWithWhitespace = ' \tturn-01\r\n';

    expect(isMobileV2LegacyRunId(asciiAtLimit)).toBe(true);
    expect(isMobileV2LegacyRunId(asciiOverLimit)).toBe(false);
    expect(isMobileV2LegacyRunId(multibyteAtLimit)).toBe(true);
    expect(isMobileV2LegacyRunId(multibyteOverLimit)).toBe(false);
    expect(isMobileV2LegacyRunId(' \t\r\n')).toBe(false);
    expect(isMobileV2LegacyRunId('\u00a0')).toBe(true);
    expect(isMobileV2LegacyRunId('')).toBe(false);
    expect(isMobileV2LegacyRunId(null)).toBe(false);

    const preserve = (value: unknown): string | undefined =>
      isMobileV2LegacyRunId(value) ? value : undefined;
    expect(preserve(acceptedWithWhitespace)).toBe(acceptedWithWhitespace);
  });

  it('uses TextEncoder byte counts and never depends on the Node Buffer global', () => {
    const corpus = [
      'turn-01',
      'a'.repeat(256),
      '🚀'.repeat(64),
      `${'🚀'.repeat(63)}abc`,
      ' \tturn-01\r\n',
    ];
    const encoder = new TextEncoder();
    for (const value of corpus) {
      expect(encoder.encode(value).byteLength).toBe(Buffer.byteLength(value));
    }

    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
    Object.defineProperty(globalThis, 'Buffer', {
      configurable: true,
      value: undefined,
      writable: true,
    });
    try {
      expect(isMobileV2LegacyRunId('turn-01')).toBe(true);
      expect(isMobileV2LegacyRunId('🚀'.repeat(64))).toBe(true);
      expect(isMobileV2LegacyRunId(`${'🚀'.repeat(64)}a`)).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'Buffer', descriptor);
      else Reflect.deleteProperty(globalThis, 'Buffer');
    }
  });

  it('rejects overlong legacy IDs before allocating a UTF-8 byte buffer', () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
      expect(isMobileV2LegacyRunId('a'.repeat(257))).toBe(false);
      expect(isMobileV2LegacyRunId('🚀'.repeat(129))).toBe(false);
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });

  it('uses LegacyRunId for every inherited run correlation in the WebSocket schema', async () => {
    const runId = 'turn-01';
    const conversationId = '00000000-0000-4000-8000-000000000002';
    const inputId = '00000000-0000-4000-8000-000000000003';
    const segmentTurnId = '00000000-0000-4000-8000-000000000004';
    const pendingInput = {
      inputId,
      kind: 'steer',
      targetTurnId: runId,
      text: 'Steer',
      state: 'delivered',
      revision: 1,
      enqueueOrder: 1,
      runId,
      segmentTurnId,
      createdAt: '2026-09-06T01:02:03Z',
      updatedAt: '2026-09-06T01:02:04Z',
    };
    expect(
      await validateWsValue('ChatSend', {
        type: 'message',
        id: runId,
        agentId: 'agent-01',
        channelId: 'mobile-ios',
        conversationId,
        text: 'Hello',
        resumable: true,
      }),
    ).toBe(true);
    expect(
      await validateWsValue('ChatAnswer', {
        type: 'answer',
        id: runId,
        questionId: 'question-01',
        answer: 'Yes',
      }),
    ).toBe(true);
    expect(await validateWsValue('ChatCancel', { type: 'cancel', id: runId })).toBe(true);
    expect(
      await validateWsValue('ChatEnqueueInput', {
        type: 'enqueue_input',
        id: '00000000-0000-4000-8000-000000000005',
        inputId,
        agentId: 'agent-01',
        channelId: 'mobile-ios',
        conversationId,
        text: 'Steer',
        behavior: 'steer',
        expectedActiveTurnId: runId,
      }),
    ).toBe(true);
    expect(
      await validateWsValue('CommandRejected', {
        type: 'command_rejected',
        id: runId,
        conversationId,
        code: 'not_found',
        error: 'Run not found',
        retryable: false,
      }),
    ).toBe(true);
    expect(await validateWsValue('MobileV2PendingInput', pendingInput)).toBe(true);

    const modelFrames: Array<[string, Record<string, unknown>]> = [
      [
        'ChatAccepted',
        {
          type: 'accepted',
          id: runId,
          conversationId,
          runId,
          segmentTurnId: runId,
          v2Seq: 1,
          userMessageId: '00000000-0000-4000-8000-000000000006',
          assistantMessageId: '00000000-0000-4000-8000-000000000007',
          revision: 1,
        },
      ],
      [
        'ChatEvent',
        {
          type: 'event',
          id: runId,
          conversationId,
          runId,
          segmentTurnId: runId,
          v2Seq: 2,
          event: { type: 'text_delta', text: 'Hello' },
        },
      ],
      [
        'ChatDone',
        {
          type: 'done',
          id: runId,
          conversationId,
          runId,
          segmentTurnId: runId,
          v2Seq: 3,
          outcome: 'completed',
        },
      ],
      [
        'ChatError',
        {
          type: 'error',
          id: runId,
          conversationId,
          runId,
          segmentTurnId: runId,
          v2Seq: 4,
          error: 'Run failed',
        },
      ],
    ];
    for (const [schemaName, frame] of modelFrames) {
      expect(await validateWsValue(schemaName, frame), schemaName).toBe(true);
    }

    const deliveredFrame = {
      type: 'input_delivered',
      id: '00000000-0000-4000-8000-000000000008',
      conversationId,
      v2Seq: 5,
      queueRevision: 2,
      input: pendingInput,
      runId,
      segmentTurnId,
      userMessageId: '00000000-0000-4000-8000-000000000009',
      assistantMessageId: '00000000-0000-4000-8000-000000000010',
    };
    expect(await validateWsValue('InputDelivered', deliveredFrame)).toBe(true);
    expect(
      await validateWsValue('InputDelivered', {
        ...deliveredFrame,
        segmentTurnId: runId,
      }),
    ).toBe(false);
  });

  it('publishes the LegacyRunId schema bounds and ASCII-only nonblank rule', async () => {
    const schema = JSON.parse(await readFile(join(root, 'chat-ws.schema.json'), 'utf8')) as {
      $defs: Record<string, Record<string, unknown>>;
    };
    expect(schema.$defs.LegacyRunId).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 256,
      'x-maxUtf8Bytes': 256,
    });
    expect(await validateWsValue('LegacyRunId', 'a'.repeat(256))).toBe(true);
    expect(await validateWsValue('LegacyRunId', 'a'.repeat(257))).toBe(false);
    expect(await validateWsValue('LegacyRunId', ' \t\r\n')).toBe(false);
    expect(await validateWsValue('LegacyRunId', '\u00a0')).toBe(true);
  });

  it('centralizes every UUID-only WebSocket field on one canonical UUID definition', async () => {
    const schema = JSON.parse(await readFile(join(root, 'chat-ws.schema.json'), 'utf8')) as {
      $defs: Record<string, Record<string, unknown>>;
    };
    expect(schema.$defs.CanonicalUuid).toEqual({
      type: 'string',
      format: 'uuid',
      pattern: '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$',
    });
    const canonical = '00000000-0000-4000-8000-000000000001';
    expect(await validateWsValue('CanonicalUuid', canonical)).toBe(true);
    expect(await validateWsValue('CanonicalUuid', `urn:uuid:${canonical}`)).toBe(false);

    const rawUuidFormats: Record<string, unknown>[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      const record = value as Record<string, unknown>;
      if (record.format === 'uuid') rawUuidFormats.push(record);
      for (const nested of Object.values(record)) visit(nested);
    };
    visit(schema);
    expect(rawUuidFormats).toHaveLength(1);
    expect(rawUuidFormats[0]).toBe(schema.$defs.CanonicalUuid);
  });

  it('keeps command, entity, conversation, transition, and message identities UUID-only', async () => {
    const commandId = '00000000-0000-4000-8000-000000000011';
    const inputId = '00000000-0000-4000-8000-000000000012';
    const conversationId = '00000000-0000-4000-8000-000000000013';
    const segmentTurnId = '00000000-0000-4000-8000-000000000014';
    const userMessageId = '00000000-0000-4000-8000-000000000015';
    const pendingInput = {
      inputId,
      kind: 'follow_up',
      text: 'Later',
      state: 'queued',
      revision: 0,
      enqueueOrder: 1,
      segmentTurnId,
      userMessageId,
      createdAt: '2026-09-06T01:02:03Z',
      updatedAt: '2026-09-06T01:02:03Z',
    };
    const enqueue = {
      type: 'enqueue_input',
      id: commandId,
      inputId,
      agentId: 'agent-01',
      channelId: 'mobile-ios',
      conversationId,
      text: 'Later',
      behavior: 'followUp',
    };

    expect(
      await validateWsValue('ChatSubscribe', {
        type: 'subscribe_conversation',
        id: 'turn-01',
        agentId: 'agent-01',
        conversationId,
        sinceV2Seq: 0,
      }),
    ).toBe(false);
    expect(await validateWsValue('ChatEnqueueInput', { ...enqueue, id: 'turn-01' })).toBe(false);
    expect(await validateWsValue('ChatEnqueueInput', { ...enqueue, inputId: 'turn-01' })).toBe(
      false,
    );
    expect(
      await validateWsValue('ChatEnqueueInput', { ...enqueue, conversationId: 'turn-01' }),
    ).toBe(false);
    expect(
      await validateWsValue('MobileV2PendingInput', {
        ...pendingInput,
        segmentTurnId: 'turn-01',
      }),
    ).toBe(false);
    expect(
      await validateWsValue('MobileV2PendingInput', {
        ...pendingInput,
        userMessageId: 'turn-01',
      }),
    ).toBe(false);
    expect(
      await validateWsValue('InputAccepted', {
        type: 'input_accepted',
        id: 'turn-01',
        conversationId,
        v2Seq: 1,
        queueRevision: 1,
        input: pendingInput,
      }),
    ).toBe(false);
  });

  it('keeps control frames unsequenced and every durable frame sequenced', async () => {
    const control = await fixture<MobileV2ControlFrame>('chat-conversation-subscribed.json');
    expect('v2Seq' in control).toBe(false);
    const durable = await fixture<MobileV2SequencedFrame>('input-accepted.json');
    expect(durable.v2Seq).toBe(8);
  });

  it('uses separate run, segment, input, command, and message identities', async () => {
    const frame = await fixture<MobileV2SequencedFrame>('input-delivered.json');
    expect(frame).toMatchObject({
      type: 'input_delivered',
      id: '00000000-0000-4000-8000-000000000021',
      runId: '00000000-0000-4000-8000-000000000003',
      segmentTurnId: '00000000-0000-4000-8000-000000000042',
      userMessageId: '00000000-0000-4000-8000-000000000043',
      assistantMessageId: '00000000-0000-4000-8000-000000000044',
    });
  });

  it('requires a target only for Steer admissions', async () => {
    expect(await validateWsFixture('chat-enqueue-steer.json')).toBe(true);
    expect(await validateWsFixture('chat-enqueue-follow-up.json')).toBe(true);
    expect(await validateWsFixture('invalid/steer-without-target.json')).toBe(false);
  });

  it('publishes /mobile/v2 and the transactional bootstrap route', async () => {
    const api = await readOpenApi();
    expect(api.servers).toEqual([{ url: '/mobile/v2' }]);
    expect(api.paths?.['/conversations/{id}/bootstrap']?.get).toBeDefined();
  });

  it('exports exact v2 page DTOs and one discriminator per control-frame branch', async () => {
    const source = await readFile(join(root, 'src', 'types.ts'), 'utf8');
    for (const declaration of [
      'export interface MobileV2ConversationPage',
      'export interface MobileV2ConversationMessagePage',
      'export interface MobileV2ReplayPage',
    ]) {
      expect(source).toContain(declaration);
    }

    const rejected = {
      type: 'command_rejected',
      id: 'turn-01',
      code: 'validation_failed',
      error: 'Invalid',
      retryable: false,
    } satisfies MobileV2WsServerFrame;
    expect(Object.keys(rejected).filter((key) => key === 'type')).toEqual(['type']);
  });

  it('keeps the linked initial run and Steer fixture identities coherent', async () => {
    const summary = await fixture<Record<string, unknown>>('conversation-summary.json');
    const bootstrap = await fixture<{
      conversation: Record<string, unknown>;
      messages: Array<Record<string, unknown>>;
      pendingInputs: Array<Record<string, unknown>>;
    }>('conversation-bootstrap.json');
    const send = await fixture<Record<string, unknown>>('chat-send.json');
    const enqueue = await fixture<Record<string, unknown>>('chat-enqueue-steer.json');
    const accepted = await fixture<Record<string, unknown>>('chat-accepted.json');
    const event = await fixture<Record<string, unknown>>('chat-event.json');
    const done = await fixture<Record<string, unknown>>('chat-done.json');
    const inputAccepted = await fixture<{ id: string; input: Record<string, unknown> }>(
      'input-accepted.json',
    );
    const delivered = await fixture<{
      id: string;
      input: Record<string, unknown>;
      runId: string;
      segmentTurnId: string;
    }>('input-delivered.json');
    const error = await fixture<Record<string, unknown>>('chat-error.json');
    const stream = (await readFile(join(root, 'fixtures', 'chat-stream.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const outerRunId = send.id;
    expect(summary.activeTurnId).toBe(outerRunId);
    expect(bootstrap.conversation.activeTurnId).toBe(outerRunId);
    for (const message of bootstrap.messages) {
      expect(message.turnId).toBe(outerRunId);
      expect(message.runId).toBe(outerRunId);
      if (message.deliveryKind === 'normal') expect(message).not.toHaveProperty('deliveryStatus');
    }
    for (const frame of [accepted, event, done, ...stream]) {
      expect(frame.id).toBe(outerRunId);
      expect(frame.runId).toBe(outerRunId);
      expect(frame.segmentTurnId).toBe(outerRunId);
    }
    expect(enqueue.expectedActiveTurnId).toBe(outerRunId);
    expect(bootstrap.pendingInputs[0]?.targetTurnId).toBe(outerRunId);
    expect(inputAccepted.id).toBe(enqueue.id);
    expect(inputAccepted.input.inputId).toBe(enqueue.inputId);
    expect(inputAccepted.input.targetTurnId).toBe(outerRunId);
    expect(delivered.id).toBe(enqueue.id);
    expect(delivered.input.inputId).toBe(enqueue.inputId);
    expect(delivered.input.targetTurnId).toBe(outerRunId);
    expect(delivered.runId).toBe(outerRunId);
    expect(delivered.input.runId).toBe(outerRunId);
    expect(delivered.segmentTurnId).not.toBe(outerRunId);
    expect(delivered.input.segmentTurnId).toBe(delivered.segmentTurnId);
    expect(error.id).toBe(error.runId);
    expect(error.id).toBe(error.segmentTurnId);
    expect(error.id).not.toBe(outerRunId);
    expect(error.id).not.toBe(delivered.segmentTurnId);
  });

  it('publishes exact page/replay schemas, strict query errors, and archived mutation errors', async () => {
    const api = (await readOpenApi()) as {
      paths: Record<
        string,
        Record<string, { parameters?: unknown[]; responses: Record<string, unknown> }>
      >;
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    for (const ref of collectLocalRefs(api)) {
      expect(resolveLocalRef(api, ref), ref).toBeDefined();
    }
    expect(api.components.schemas).toHaveProperty('MobileV2ConversationPage');
    expect(api.components.schemas).not.toHaveProperty('ConversationPage');
    expect(api.components.schemas).toHaveProperty('MobileV2ConversationMessagePage');
    expect(api.components.schemas.MobileV2ReplayPage).toMatchObject({
      additionalProperties: false,
      required: ['frames', 'v2ThroughSeq'],
    });

    const paths = api.paths;
    expect(paths['/conversations'].get.responses).toHaveProperty('400');
    expect(paths['/conversations'].post.responses).toHaveProperty('404');
    expect(paths['/conversations/{id}'].patch.responses['409']).toBeDefined();
    expect(paths['/conversations/{id}'].delete.responses).toHaveProperty('400');
    expect(paths['/conversations/{id}/messages'].get.responses).toHaveProperty('400');
    expect(paths['/conversations/{id}/bootstrap'].get.parameters).toEqual([
      { $ref: '#/components/parameters/MessageLimit' },
      { $ref: '#/components/parameters/BeforeCursor' },
    ]);
    expect(paths['/conversations/{id}/bootstrap'].get.responses).toHaveProperty('400');
    expect(paths['/agents/{agentId}/conversations/{conversationId}/events'].get.parameters).toEqual(
      [{ $ref: '#/components/parameters/SinceV2Seq' }],
    );
    expect(
      paths['/agents/{agentId}/conversations/{conversationId}/events'].get.responses,
    ).toHaveProperty('400');
    expect(paths['/models'].get.responses).toHaveProperty('400');

    const patchConflict = JSON.stringify(paths['/conversations/{id}'].patch.responses['409']);
    const deleteConflict = JSON.stringify(paths['/conversations/{id}'].delete.responses['409']);
    expect(patchConflict).toContain('ConversationArchivedError');
    expect(deleteConflict).toContain('ConversationArchivedError');
  });

  it('bounds the reusable quoted safe-integer schema used by If-Match', async () => {
    const api = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      components: {
        parameters: Record<string, { schema: unknown }>;
        schemas: Record<string, Record<string, unknown>>;
      };
    };
    expect(api.components.parameters.IfMatch.schema).toEqual({
      $ref: '#/components/schemas/QuotedSafeInteger',
    });
    expect(api.components.schemas.QuotedSafeInteger).toBeDefined();
    expect(await validateOpenApiValue('QuotedSafeInteger', '"9007199254740991"')).toBe(true);
    expect(await validateOpenApiValue('QuotedSafeInteger', '"9007199254740992"')).toBe(false);
  });

  it('keeps REST and WebSocket UUID-only fields canonical while inherited run IDs stay bounded', async () => {
    const api = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const canonical = '00000000-0000-4000-8000-000000000001';
    expect(api.components.schemas.CanonicalUuid).toEqual({
      type: 'string',
      format: 'uuid',
      pattern: '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$',
    });
    expect(api.components.schemas.LegacyRunId).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 256,
      'x-maxUtf8Bytes': 256,
    });
    expect(await validateOpenApiValue('CanonicalUuid', canonical)).toBe(true);
    expect(await validateOpenApiValue('CanonicalUuid', `urn:uuid:${canonical}`)).toBe(false);
    expect(await validateOpenApiValue('LegacyRunId', 'turn-01')).toBe(true);
    expect(await validateOpenApiValue('LegacyRunId', ' '.repeat(4))).toBe(false);

    const summary = await fixture<Record<string, unknown>>('conversation-summary.json');
    expect(
      await validateOpenApiValue('MobileV2ConversationSummary', {
        ...summary,
        id: `urn:uuid:${summary.id as string}`,
      }),
    ).toBe(false);
    expect(
      await validateOpenApiValue('MobileV2ConversationSummary', {
        ...summary,
        activeTurnId: 'turn-01',
      }),
    ).toBe(true);

    const rawUuidFormats: Record<string, unknown>[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>;
        if (record.format === 'uuid') rawUuidFormats.push(record);
        for (const nested of Object.values(record)) visit(nested);
      }
    };
    visit(api);
    expect(rawUuidFormats).toHaveLength(1);
    expect(rawUuidFormats[0]).toBe(api.components.schemas.CanonicalUuid);
  });

  it('keeps REST sequenced frames structurally aligned with the WebSocket document', async () => {
    const api = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const ws = JSON.parse(await readFile(join(root, 'chat-ws.schema.json'), 'utf8')) as {
      $defs: Record<string, Record<string, unknown>>;
    };
    const branchNames = [
      'ChatAccepted',
      'ChatEvent',
      'ChatDone',
      'ChatError',
      'InputAccepted',
      'InputUpdated',
      'InputRemoved',
      'InputDelivered',
      'InputFailed',
      'QueuePaused',
      'QueueResumed',
    ];
    for (const name of branchNames) {
      const rest = api.components.schemas[name];
      const socket = ws.$defs[name];
      expect(rest, name).toBeDefined();
      expect(rest.required, name).toEqual(socket.required);
      expect(Object.keys(rest.properties as object).sort(), name).toEqual(
        Object.keys(socket.properties as object).sort(),
      );
      expect(rest.additionalProperties, name).toBe(false);
    }
  });

  it('caps wire counters/images and validates page plus legacy-run fixtures', async () => {
    const api = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      components: {
        parameters: Record<string, { schema: Record<string, unknown> }>;
        schemas: Record<string, Record<string, unknown>>;
      };
    };
    const safeMax = Number.MAX_SAFE_INTEGER;
    expect(api.components.parameters.ConversationLimit.schema.maximum).toBe(100);
    expect(api.components.parameters.MessageLimit.schema.maximum).toBe(200);
    expect(api.components.parameters.SinceV2Seq.schema.maximum).toBe(safeMax);

    const cappedIntegerFields = new Set([
      'lastSeq',
      'ordinal',
      'queueRevision',
      'revision',
      'throughSeq',
      'v2LastSeq',
      'v2Seq',
      'v2ThroughSeq',
    ]);
    const visitedCappedFields = new Set<string>();
    const assertWireIntegerCaps = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => assertWireIntegerCaps(item, `${path}[${index}]`));
        return;
      }
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (cappedIntegerFields.has(key) && child && typeof child === 'object') {
          visitedCappedFields.add(key);
          expect((child as Record<string, unknown>).maximum, `${path}.${key}`).toBe(safeMax);
        }
        assertWireIntegerCaps(child, `${path}.${key}`);
      }
    };
    assertWireIntegerCaps(api.components.schemas, 'components.schemas');
    expect([...visitedCappedFields].sort()).toEqual([...cappedIntegerFields].sort());
    expect(
      (
        (api.components.schemas.ConversationContent.oneOf as Array<Record<string, unknown>>)[0]
          .properties as Record<string, Record<string, unknown>>
      ).images.maxItems,
    ).toBe(4);
    expect(
      (
        api.components.schemas.MobileV2PendingInput.properties as Record<
          string,
          Record<string, unknown>
        >
      ).images.maxItems,
    ).toBe(4);

    for (const [file, schemaName] of [
      ['conversation-page.json', 'MobileV2ConversationPage'],
      ['conversation-message-page.json', 'MobileV2ConversationMessagePage'],
      ['conversation-replay-page.json', 'MobileV2ReplayPage'],
      ['conversation-bootstrap-legacy-run.json', 'MobileV2ConversationBootstrap'],
    ]) {
      expect(await validateOpenApiValue(schemaName, await fixture(file)), file).toBe(true);
    }
    for (const file of [
      'chat-send-legacy-run.json',
      'chat-answer-legacy-run.json',
      'chat-cancel-legacy-run.json',
      'command-rejected-legacy-run.json',
      'chat-send-legacy-run-max.json',
    ]) {
      expect(await validateWsFixture(file), file).toBe(true);
    }
    const maxLegacyRunId = (await fixture<{ id: string }>('chat-send-legacy-run-max.json')).id;
    const tooLargeLegacyRunId = (
      await fixture<{ id: string }>('invalid/legacy-run-id-too-large.json')
    ).id;
    expect(new TextEncoder().encode(maxLegacyRunId)).toHaveLength(256);
    expect(new TextEncoder().encode(tooLargeLegacyRunId)).toHaveLength(257);
    const legacyStream = (
      await readFile(join(root, 'fixtures', 'chat-stream-legacy-run.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    for (const frame of legacyStream) {
      expect(await validateWsValue('MobileV2WsFrame', frame)).toBe(true);
    }
    expect(await validateWsFixture('invalid/legacy-run-id-too-large.json')).toBe(false);
    expect(await validateWsFixture('invalid/legacy-run-id-blank.json')).toBe(false);
  });

  it('validates every fixture against its declared schema and polarity', async () => {
    const openapi = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as object;
    const ws = JSON.parse(await readFile(join(root, 'chat-ws.schema.json'), 'utf8')) as object;
    const manifest = await fixture<FixtureManifest>('manifest.json');
    expect(manifest.version).toBe(2);

    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    ajv.addSchema(openapi, 'mobile-v2-openapi');
    ajv.addSchema(ws, 'mobile-v2-chat-ws');

    for (const entry of manifest.cases) {
      const raw = await readFile(join(root, 'fixtures', entry.file), 'utf8');
      const values =
        entry.format === 'jsonl'
          ? raw
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line) as unknown)
          : [JSON.parse(raw) as unknown];
      const ref =
        entry.document === 'openapi'
          ? `mobile-v2-openapi#/components/schemas/${entry.schema}`
          : `mobile-v2-chat-ws#/$defs/${entry.schema}`;
      const validate = ajv.compile({ $ref: ref });
      const results = values.map((value) => validate(value));
      expect(results.every(Boolean), `${entry.file}: ${ajv.errorsText(validate.errors)}`).toBe(
        entry.valid,
      );
    }
  });

  it('names every fixture exactly once and lists all invalid examples', async () => {
    const manifest = await fixture<FixtureManifest>('manifest.json');
    const files = manifest.cases.map((entry) => entry.file);
    expect(new Set(files).size).toBe(files.length);
    expect([...files].sort()).toEqual(await listFixtureFiles(join(root, 'fixtures')));
    expect(files.filter((file) => file.startsWith('invalid/')).sort()).toEqual([
      'invalid/control-with-v2-seq.json',
      'invalid/legacy-run-id-blank.json',
      'invalid/legacy-run-id-too-large.json',
      'invalid/negative-revision.json',
      'invalid/non-uuid-command-id.json',
      'invalid/steer-without-target.json',
      'invalid/transition-without-v2-seq.json',
      'invalid/unknown-command-field.json',
    ]);
  });
});
