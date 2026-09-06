import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import {
  CHAT_INPUT_QUEUE_CAPABILITY,
  MOBILE_V2_CONTRACT_VERSION,
  type MobileV2ControlFrame,
  type MobileV2SequencedFrame,
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
      id: '00000000-0000-4000-8000-000000000031',
      runId: '00000000-0000-4000-8000-000000000041',
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
      'invalid/negative-revision.json',
      'invalid/non-uuid-command-id.json',
      'invalid/steer-without-target.json',
      'invalid/transition-without-v2-seq.json',
      'invalid/unknown-command-field.json',
    ]);
  });
});
