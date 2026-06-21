import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type MarketplaceConfig,
  PluginOpError,
  readMarketplace,
  resolveMarketplacePlugin,
} from './index.js';

const execFileAsync = promisify(execFile);

/** A valid marketplace config used across several tests. */
const SAMPLE: MarketplaceConfig = {
  name: 'acme-marketplace',
  owner: 'acme',
  description: 'A test marketplace',
  plugins: [
    {
      name: 'hello-plugin',
      source: 'git:acme/hello-plugin',
      description: 'Says hello',
      author: 'Acme',
      version: '1.0.0',
    },
    { name: 'bare-plugin', source: '/abs/path/to/bare-plugin' },
  ],
};

describe('readMarketplace — local', () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'dash-marketplace-test-'));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('reads marketplace.json from a directory', async () => {
    await writeFile(join(work, 'marketplace.json'), JSON.stringify(SAMPLE));
    const cfg = await readMarketplace(work);
    expect(cfg.name).toBe('acme-marketplace');
    expect(cfg.owner).toBe('acme');
    expect(cfg.description).toBe('A test marketplace');
    expect(cfg.plugins).toHaveLength(2);
    expect(cfg.plugins[0]).toEqual({
      name: 'hello-plugin',
      source: 'git:acme/hello-plugin',
      description: 'Says hello',
      author: 'Acme',
      version: '1.0.0',
    });
    expect(cfg.plugins[1]).toEqual({ name: 'bare-plugin', source: '/abs/path/to/bare-plugin' });
  });

  it('reads a direct .json file path', async () => {
    const file = join(work, 'custom-marketplace.json');
    await writeFile(file, JSON.stringify(SAMPLE));
    const cfg = await readMarketplace(file);
    expect(cfg.name).toBe('acme-marketplace');
    expect(cfg.plugins).toHaveLength(2);
  });

  it('omits optional fields that are absent', async () => {
    await writeFile(
      join(work, 'marketplace.json'),
      JSON.stringify({ plugins: [{ name: 'p', source: 's' }] }),
    );
    const cfg = await readMarketplace(work);
    expect(cfg.name).toBeUndefined();
    expect(cfg.owner).toBeUndefined();
    expect(cfg.description).toBeUndefined();
    expect(cfg.plugins).toEqual([{ name: 'p', source: 's' }]);
    expect(cfg.plugins[0].version).toBeUndefined();
  });

  it('throws not_found for a missing directory', async () => {
    await expect(readMarketplace(join(work, 'nope'))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws not_found when the directory has no marketplace.json', async () => {
    await expect(readMarketplace(work)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws not_found for a missing .json file path', async () => {
    await expect(readMarketplace(join(work, 'missing.json'))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('throws invalid_manifest for malformed JSON', async () => {
    await writeFile(join(work, 'marketplace.json'), '{ not valid json');
    await expect(readMarketplace(work)).rejects.toMatchObject({ code: 'invalid_manifest' });
  });

  it('throws invalid_manifest when the top level is not an object', async () => {
    await writeFile(join(work, 'marketplace.json'), JSON.stringify([1, 2, 3]));
    await expect(readMarketplace(work)).rejects.toMatchObject({ code: 'invalid_manifest' });
  });

  it('throws invalid_manifest when plugins is not an array', async () => {
    await writeFile(join(work, 'marketplace.json'), JSON.stringify({ plugins: { a: 1 } }));
    await expect(readMarketplace(work)).rejects.toMatchObject({ code: 'invalid_manifest' });
  });

  it('throws invalid_manifest when an entry is missing name', async () => {
    await writeFile(
      join(work, 'marketplace.json'),
      JSON.stringify({ plugins: [{ source: 'only-source' }] }),
    );
    await expect(readMarketplace(work)).rejects.toMatchObject({ code: 'invalid_manifest' });
  });

  it('throws invalid_manifest when an entry is missing source', async () => {
    await writeFile(
      join(work, 'marketplace.json'),
      JSON.stringify({ plugins: [{ name: 'only-name' }] }),
    );
    await expect(readMarketplace(work)).rejects.toMatchObject({ code: 'invalid_manifest' });
  });

  it('does not pollute the prototype via a __proto__ entry', async () => {
    // A crafted marketplace whose top-level + entry carry a `__proto__` key.
    const raw = `{
      "plugins": [{ "name": "ok", "source": "s", "__proto__": { "polluted": true } }],
      "__proto__": { "pollutedTop": true }
    }`;
    await writeFile(join(work, 'marketplace.json'), raw);
    const cfg = await readMarketplace(work);

    // The result and its entries must NOT have inherited the injected key.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((cfg as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect((cfg.plugins[0] as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>).pollutedTop).toBeUndefined();
    // The legitimate fields are still reconstructed.
    expect(cfg.plugins[0]).toEqual({ name: 'ok', source: 's' });
  });
});

describe('readMarketplace — url', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches and parses marketplace.json over https', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(SAMPLE), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const cfg = await readMarketplace('https://example.com/marketplace.json');
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/marketplace.json');
    expect(cfg.name).toBe('acme-marketplace');
    expect(cfg.plugins).toHaveLength(2);
  });

  it('throws not_found on a 404 response', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(readMarketplace('https://example.com/marketplace.json')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('throws not_found when fetch itself rejects', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(readMarketplace('https://example.com/marketplace.json')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('throws invalid_manifest when the fetched body is malformed JSON', async () => {
    const fetchMock = vi.fn(async () => new Response('{ broken', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(readMarketplace('https://example.com/marketplace.json')).rejects.toMatchObject({
      code: 'invalid_manifest',
    });
  });
});

describe('readMarketplace — git', () => {
  let work: string;
  let repo: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'dash-marketplace-git-test-'));
    repo = join(work, 'origin');
    await mkdir(repo, { recursive: true });
    await execFileAsync('git', ['init', '-q'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('clones a local git repo and reads its marketplace.json', async () => {
    await writeFile(join(repo, 'marketplace.json'), JSON.stringify(SAMPLE));
    await execFileAsync('git', ['add', 'marketplace.json'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });

    const cfg = await readMarketplace(`git:${repo}`);
    expect(cfg.name).toBe('acme-marketplace');
    expect(cfg.plugins).toHaveLength(2);
  });

  it('reads marketplace.json from a subpath inside a cloned git repo', async () => {
    await mkdir(join(repo, 'registry'), { recursive: true });
    await writeFile(join(repo, 'registry', 'marketplace.json'), JSON.stringify(SAMPLE));
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });

    const cfg = await readMarketplace(`git:${repo}#registry`);
    expect(cfg.name).toBe('acme-marketplace');
  });

  it('throws not_found when the clone fails', async () => {
    await expect(readMarketplace(`git:${join(work, 'no-such-repo')}`)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('throws not_found when the cloned repo has no marketplace.json', async () => {
    await writeFile(join(repo, 'README.md'), 'hi');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });

    await expect(readMarketplace(`git:${repo}`)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('resolveMarketplacePlugin', () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'dash-marketplace-resolve-test-'));
    await writeFile(join(work, 'marketplace.json'), JSON.stringify(SAMPLE));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('returns the entry whose name matches', async () => {
    const entry = await resolveMarketplacePlugin(work, 'hello-plugin');
    expect(entry).toEqual({
      name: 'hello-plugin',
      source: 'git:acme/hello-plugin',
      description: 'Says hello',
      author: 'Acme',
      version: '1.0.0',
    });
  });

  it('throws not_found when the entry is absent', async () => {
    await expect(resolveMarketplacePlugin(work, 'does-not-exist')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('propagates not_found when the marketplace itself is missing', async () => {
    await expect(
      resolveMarketplacePlugin(join(work, 'nope'), 'hello-plugin'),
    ).rejects.toBeInstanceOf(PluginOpError);
  });
});
