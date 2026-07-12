import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

interface FixtureCase {
  file: string;
  document: 'openapi' | 'chat-ws';
  schema: string;
  valid: boolean;
  format?: 'json' | 'jsonl' | 'sse';
}

function isAscendingReplay(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('entries' in value)) return true;
  const entries = (value as { entries?: Array<{ seq?: unknown }> }).entries;
  if (!Array.isArray(entries)) return true;
  return entries.every(
    (entry, index) =>
      typeof entry.seq === 'number' &&
      (index === 0 || entry.seq > (entries[index - 1].seq as number)),
  );
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseSse(raw: string): unknown[] {
  return raw
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(6)) as unknown);
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

describe('mobile v1 contract fixtures', () => {
  it('matches every manifest case to its declared schema and polarity', async () => {
    const openapi = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as object;
    const ws = JSON.parse(await readFile(join(root, 'chat-ws.schema.json'), 'utf8')) as object;
    const manifest = JSON.parse(
      await readFile(join(root, 'fixtures', 'manifest.json'), 'utf8'),
    ) as { version: number; cases: FixtureCase[] };
    expect(manifest.version).toBe(1);

    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    ajv.addSchema(openapi, 'mobile-openapi');
    ajv.addSchema(ws, 'mobile-chat-ws');

    for (const fixture of manifest.cases) {
      const raw = await readFile(join(root, 'fixtures', fixture.file), 'utf8');
      const values =
        fixture.format === 'jsonl'
          ? raw
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line) as unknown)
          : fixture.format === 'sse'
            ? parseSse(raw)
            : [JSON.parse(raw) as unknown];
      const ref =
        fixture.document === 'openapi'
          ? `mobile-openapi#/components/schemas/${fixture.schema}`
          : `mobile-chat-ws#/$defs/${fixture.schema}`;
      const validate = ajv.compile({ $ref: ref });
      const results = values.map(
        (value) =>
          validate(value) && (fixture.schema === 'ReplayPage' ? isAscendingReplay(value) : true),
      );
      expect(results.every(Boolean), `${fixture.file}: ${ajv.errorsText(validate.errors)}`).toBe(
        fixture.valid,
      );
    }
  });

  it('has no duplicate or unlisted fixture files', async () => {
    const manifest = JSON.parse(
      await readFile(join(root, 'fixtures', 'manifest.json'), 'utf8'),
    ) as { cases: FixtureCase[] };
    const files = manifest.cases.map((entry) => entry.file);
    expect(new Set(files).size).toBe(files.length);
    expect([...files].sort()).toEqual(await listFixtureFiles(join(root, 'fixtures')));
  });
});
