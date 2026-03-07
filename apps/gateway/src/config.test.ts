import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, parseFlags } from './config.js';

describe('parseFlags', () => {
  it('extracts --config flag', () => {
    expect(parseFlags(['--config', '/path/to/config.json'])).toEqual({
      configPath: '/path/to/config.json',
    });
  });

  it('extracts --secrets flag', () => {
    expect(parseFlags(['--secrets', '/path/to/secrets.json'])).toEqual({
      secretsPath: '/path/to/secrets.json',
    });
  });

  it('extracts both flags', () => {
    expect(
      parseFlags(['--config', '/path/config.json', '--secrets', '/path/secrets.json']),
    ).toEqual({
      configPath: '/path/config.json',
      secretsPath: '/path/secrets.json',
    });
  });

  it('returns empty for no flags', () => {
    expect(parseFlags([])).toEqual({});
  });

  it('ignores flags without values', () => {
    expect(parseFlags(['--config'])).toEqual({});
  });
});

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gateway-config-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  const validConfig = {
    channels: {
      mc: { adapter: 'mission-control', port: 9200 }, // agent not required for MC
    },
    agents: {
      default: { url: 'ws://localhost:9101/ws', token: 'test-token' },
    },
  };

  it('loads config from file', async () => {
    const configPath = join(tmpDir, 'config.json');
    await writeFile(configPath, JSON.stringify(validConfig));

    const config = await loadConfig({ configPath });
    expect(config.channels.mc.adapter).toBe('mission-control');
    expect(config.agents.default.url).toBe('ws://localhost:9101/ws');
  });

  it('throws without --config flag', async () => {
    await expect(loadConfig()).rejects.toThrow('Gateway requires --config');
  });

  it('throws when telegram channel references unknown agent', async () => {
    const bad = {
      channels: { tg: { adapter: 'telegram', agent: 'nonexistent', token: 'tok' } },
      agents: { default: { url: 'ws://localhost:9101/ws', token: 't' } },
    };
    const configPath = join(tmpDir, 'bad.json');
    await writeFile(configPath, JSON.stringify(bad));

    await expect(loadConfig({ configPath })).rejects.toThrow('unknown agent "nonexistent"');
  });

  it('accepts mission-control channel without agent field', async () => {
    const cfg = {
      channels: { mc: { adapter: 'mission-control', port: 9200 } },
      agents: { default: { url: 'ws://localhost:9101/ws', token: 't' } },
    };
    const configPath = join(tmpDir, 'mc.json');
    await writeFile(configPath, JSON.stringify(cfg));

    const config = await loadConfig({ configPath });
    expect(config.channels.mc.adapter).toBe('mission-control');
  });

  it('throws when no channels defined', async () => {
    const bad = { channels: {}, agents: { default: { url: 'ws://x', token: 't' } } };
    const configPath = join(tmpDir, 'empty-channels.json');
    await writeFile(configPath, JSON.stringify(bad));

    await expect(loadConfig({ configPath })).rejects.toThrow('at least one channel');
  });

  it('merges secrets and unlinks file', async () => {
    const configPath = join(tmpDir, 'config.json');
    const secretsPath = join(tmpDir, 'secrets.json');
    await writeFile(configPath, JSON.stringify(validConfig));
    await writeFile(
      secretsPath,
      JSON.stringify({ agents: { default: { token: 'secret-token' } } }),
    );

    const config = await loadConfig({ configPath, secretsPath });
    expect(config.agents.default.token).toBe('secret-token');

    // Secrets file should be deleted
    const { existsSync } = await import('node:fs');
    expect(existsSync(secretsPath)).toBe(false);
  });
});
