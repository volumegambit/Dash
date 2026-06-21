import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Header } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PluginOpError,
  type PluginScanVerdict,
  installPluginToDir,
  parsePluginSource,
} from './install.js';

describe('parsePluginSource', () => {
  it('parses a git source with subpath and ref', () => {
    expect(parsePluginSource('git:owner/repo/plugins/my-plugin@main')).toEqual({
      kind: 'git',
      owner: 'owner',
      repo: 'repo',
      subpath: 'plugins/my-plugin',
      ref: 'main',
    });
  });

  it('parses a git source without subpath or ref', () => {
    expect(parsePluginSource('git:owner/repo')).toEqual({
      kind: 'git',
      owner: 'owner',
      repo: 'repo',
      subpath: undefined,
      ref: undefined,
    });
  });

  it('parses a git source with subpath but no ref', () => {
    expect(parsePluginSource('git:owner/repo/sub/path')).toEqual({
      kind: 'git',
      owner: 'owner',
      repo: 'repo',
      subpath: 'sub/path',
      ref: undefined,
    });
  });

  it('parses an https url source', () => {
    expect(parsePluginSource('https://example.com/plugins/x.tar.gz')).toEqual({
      kind: 'url',
      url: 'https://example.com/plugins/x.tar.gz',
    });
  });

  it('parses an http url source', () => {
    expect(parsePluginSource('http://example.com/plugins/x.tar.gz')).toEqual({
      kind: 'url',
      url: 'http://example.com/plugins/x.tar.gz',
    });
  });

  it('treats a relative path as a local source', () => {
    expect(parsePluginSource('./my-plugin')).toEqual({ kind: 'local', path: './my-plugin' });
  });

  it('treats an absolute path as a local source', () => {
    expect(parsePluginSource('/abs/path')).toEqual({ kind: 'local', path: '/abs/path' });
  });

  it('treats a home-relative path as a local source', () => {
    expect(parsePluginSource('~/plugins/my-plugin')).toEqual({
      kind: 'local',
      path: '~/plugins/my-plugin',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parsePluginSource('  /abs/path  ')).toEqual({ kind: 'local', path: '/abs/path' });
  });

  it('rejects a malformed git source', () => {
    expect(() => parsePluginSource('git:owner')).toThrow(/Invalid git source/);
  });

  it('rejects an empty source', () => {
    expect(() => parsePluginSource('')).toThrow();
    expect(() => parsePluginSource('   ')).toThrow();
  });
});

describe('PluginOpError', () => {
  it('carries a code and message', () => {
    const err = new PluginOpError('not_found', 'nope');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PluginOpError);
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('nope');
    expect(err.name).toBe('PluginOpError');
  });

  it('exposes code via the generic `code in err` check', () => {
    const err: unknown = new PluginOpError('duplicate', 'dupe');
    expect(err instanceof Error && 'code' in err).toBe(true);
    expect((err as { code?: string }).code).toBe('duplicate');
  });
});

// --- tarball helpers ---------------------------------------------------------

/** A single tar member: a 512-byte header + padded body. */
function tarEntry(name: string, content: string): Buffer {
  const body = Buffer.from(content, 'utf8');
  const header = new Header({
    path: name,
    type: 'File',
    size: body.length,
    mode: 0o644,
    mtime: new Date(),
  });
  header.encode();
  const headerBlock = header.block;
  if (!headerBlock) throw new Error('failed to encode tar header');
  const pad = (512 - (body.length % 512)) % 512;
  return Buffer.concat([headerBlock, body, Buffer.alloc(pad)]);
}

/**
 * Build an UNCOMPRESSED tar archive from `{name: content}` entries, terminated
 * by the two zero blocks tar uses for EOF. The names are written verbatim — so
 * a `../escape.txt` member survives into the archive, which is exactly what the
 * zip-slip test needs (the high-level `tar.c` API would normalize it away).
 */
function buildTar(entries: Record<string, string>): Buffer {
  const blocks = Object.entries(entries).map(([name, content]) => tarEntry(name, content));
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

/** Gzip a buffer (so the result is a real `.tar.gz`). */
async function gzip(buf: Buffer): Promise<Buffer> {
  const { gzipSync } = await import('node:zlib');
  return gzipSync(buf);
}

const safe = async (): Promise<PluginScanVerdict> => ({ verdict: 'safe', reasons: [] });

describe('installPluginToDir', () => {
  let work: string;
  let dataDir: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'dash-plugin-install-test-'));
    dataDir = join(work, 'data');
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('rejects a tarball whose member escapes the root (zip-slip → corrupt_archive)', async () => {
    const malicious = await gzip(
      buildTar({
        'my-plugin/.claude-plugin/plugin.json': JSON.stringify({ name: 'my-plugin' }),
        '../escape.txt': 'pwned',
      }),
    );
    const tgz = join(work, 'evil.tar.gz');
    await writeFile(tgz, malicious);

    await expect(installPluginToDir({ dataDir, source: tgz, scanner: safe })).rejects.toMatchObject(
      { code: 'corrupt_archive' },
    );

    // The escaping payload must NOT have been written next to the temp root or
    // anywhere under the data dir.
    expect(existsSync(join(work, 'escape.txt'))).toBe(false);
    expect(existsSync(join(dataDir, 'plugins', 'my-plugin'))).toBe(false);
  });

  it('rejects a tarball whose member is an absolute path (zip-slip → corrupt_archive)', async () => {
    const abs = join(work, 'pwned-abs.txt');
    const malicious = await gzip(
      buildTar({
        'my-plugin/.claude-plugin/plugin.json': JSON.stringify({ name: 'my-plugin' }),
        [abs]: 'pwned',
      }),
    );
    const tgz = join(work, 'evil-abs.tar.gz');
    await writeFile(tgz, malicious);

    await expect(installPluginToDir({ dataDir, source: tgz, scanner: safe })).rejects.toMatchObject(
      { code: 'corrupt_archive' },
    );
    expect(existsSync(abs)).toBe(false);
  });

  it('installs a valid .tar.gz, using the manifest name, with files on disk', async () => {
    const tar = buildTar({
      'pkg/.claude-plugin/plugin.json': JSON.stringify({
        name: 'cool-plugin',
        version: '1.2.3',
        description: 'a cool plugin',
      }),
      'pkg/commands/hello.md': '# hello',
    });
    const tgz = join(work, 'cool.tar.gz');
    await writeFile(tgz, await gzip(tar));

    const result = await installPluginToDir({ dataDir, source: tgz, scanner: safe });

    expect(result.name).toBe('cool-plugin');
    expect(result.version).toBe('1.2.3');
    expect(result.description).toBe('a cool plugin');
    expect(result.verdict).toEqual({ verdict: 'safe', reasons: [] });
    expect(result.source).toBe(tgz);

    const installDir = join(dataDir, 'plugins', 'cool-plugin');
    expect(result.location).toBe(installDir);
    expect(existsSync(installDir)).toBe(true);
    const manifest = JSON.parse(
      await readFile(join(installDir, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    expect(manifest.name).toBe('cool-plugin');
    expect(await readFile(join(installDir, 'commands', 'hello.md'), 'utf8')).toBe('# hello');
  });

  it('installs from a local directory (copied, source left in place)', async () => {
    const src = join(work, 'src-plugin');
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(src, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'local-plugin' }),
    );
    await mkdir(join(src, 'commands'), { recursive: true });
    await writeFile(join(src, 'commands', 'go.md'), '# go');

    const result = await installPluginToDir({ dataDir, source: src, scanner: safe });

    expect(result.name).toBe('local-plugin');
    expect(existsSync(join(dataDir, 'plugins', 'local-plugin', 'commands', 'go.md'))).toBe(true);
    // Source dir must still exist (we copy, never move the user's source).
    expect(existsSync(join(src, 'commands', 'go.md'))).toBe(true);
  });

  it('falls back to the directory name when no manifest is present', async () => {
    const src = join(work, 'bare-plugin');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'README.md'), 'hi');

    const result = await installPluginToDir({ dataDir, source: src, scanner: safe });
    expect(result.name).toBe('bare-plugin');
    expect(existsSync(join(dataDir, 'plugins', 'bare-plugin'))).toBe(true);
  });

  it('honors the name override when the manifest has no name', async () => {
    const src = join(work, 'NotKebab');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'README.md'), 'hi');

    const result = await installPluginToDir({
      dataDir,
      source: src,
      name: 'overridden-name',
      scanner: safe,
    });
    expect(result.name).toBe('overridden-name');
    expect(existsSync(join(dataDir, 'plugins', 'overridden-name'))).toBe(true);
  });

  it('throws duplicate when a plugin with that name already exists', async () => {
    await mkdir(join(dataDir, 'plugins', 'dup-plugin'), { recursive: true });

    const src = join(work, 'dup-src');
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(src, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'dup-plugin' }),
    );

    await expect(installPluginToDir({ dataDir, source: src, scanner: safe })).rejects.toMatchObject(
      {
        code: 'duplicate',
      },
    );
  });

  it('throws dangerous when the scanner returns a dangerous verdict', async () => {
    const src = join(work, 'danger-src');
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(src, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'danger-plugin' }),
    );

    const dangerous = async (): Promise<PluginScanVerdict> => ({
      verdict: 'dangerous',
      reasons: ['pipes a download straight into a shell', 'embeds a private key'],
    });

    await expect(
      installPluginToDir({ dataDir, source: src, scanner: dangerous }),
    ).rejects.toMatchObject({
      code: 'dangerous',
      message: 'pipes a download straight into a shell; embeds a private key',
    });
    // Nothing installed.
    expect(existsSync(join(dataDir, 'plugins', 'danger-plugin'))).toBe(false);
  });

  it('proceeds when the scanner returns suspicious', async () => {
    const src = join(work, 'sus-src');
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(src, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'sus-plugin' }),
    );

    const suspicious = async (): Promise<PluginScanVerdict> => ({
      verdict: 'suspicious',
      reasons: ['reads environment variables'],
    });

    const result = await installPluginToDir({ dataDir, source: src, scanner: suspicious });
    expect(result.name).toBe('sus-plugin');
    expect(result.verdict.verdict).toBe('suspicious');
    expect(existsSync(join(dataDir, 'plugins', 'sus-plugin'))).toBe(true);
  });

  it('throws scan_failed when the scanner throws', async () => {
    const src = join(work, 'throw-src');
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(src, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'throw-plugin' }),
    );

    const throwing = async (): Promise<PluginScanVerdict> => {
      throw new Error('scanner blew up');
    };

    await expect(
      installPluginToDir({ dataDir, source: src, scanner: throwing }),
    ).rejects.toMatchObject({ code: 'scan_failed' });
    expect(existsSync(join(dataDir, 'plugins', 'throw-plugin'))).toBe(false);
  });

  it('throws invalid_manifest when the manifest fails validation', async () => {
    const src = join(work, 'bad-manifest-src');
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(src, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'NotKebabCase' }),
    );

    await expect(installPluginToDir({ dataDir, source: src, scanner: safe })).rejects.toMatchObject(
      {
        code: 'invalid_manifest',
      },
    );
  });

  it('throws not_found for a bad url', async () => {
    await expect(
      installPluginToDir({
        dataDir,
        source: 'https://127.0.0.1:1/does-not-exist.tar.gz',
        scanner: safe,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws not_found for a missing local path', async () => {
    await expect(
      installPluginToDir({ dataDir, source: join(work, 'nope'), scanner: safe }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not leave temp dirs behind after a successful install', async () => {
    const src = join(work, 'clean-src');
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(src, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'clean-plugin' }),
    );
    const result = await installPluginToDir({ dataDir, source: src, scanner: safe });
    expect(existsSync(result.location)).toBe(true);
    // The plugins dir should contain exactly the one install, no temp leftovers.
    const { readdir } = await import('node:fs/promises');
    const installed = await readdir(join(dataDir, 'plugins'));
    expect(installed).toEqual(['clean-plugin']);
  });
});
