import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, parseFlags } from './config.js';

describe('parseFlags', () => {
  it('parses --config flag', () => {
    const result = parseFlags(['--config', '/path/to/config.json']);
    expect(result.configPath).toBe('/path/to/config.json');
  });

  it('parses --secrets flag', () => {
    const result = parseFlags(['--secrets', '/path/to/secrets.json']);
    expect(result.secretsPath).toBe('/path/to/secrets.json');
  });

  it('parses both flags together', () => {
    const result = parseFlags([
      '--config',
      '/path/to/config.json',
      '--secrets',
      '/path/to/secrets.json',
    ]);
    expect(result.configPath).toBe('/path/to/config.json');
    expect(result.secretsPath).toBe('/path/to/secrets.json');
  });

  it('returns empty options with no flags', () => {
    const result = parseFlags([]);
    expect(result).toEqual({});
  });

  it('ignores unknown flags', () => {
    const result = parseFlags(['--unknown', 'value', '--config', '/path/to/config.json']);
    expect(result.configPath).toBe('/path/to/config.json');
    expect(result.secretsPath).toBeUndefined();
  });

  it('ignores flag without value', () => {
    const result = parseFlags(['--config']);
    expect(result.configPath).toBeUndefined();
  });
});

describe('loadConfig with --config and --secrets', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dash-config-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it('loads config from explicit --config path', async () => {
    const configPath = join(tmpDir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        agents: {
          custom: {
            model: 'claude-haiku-3',
            systemPrompt: 'Custom prompt',
          },
        },
      }),
    );

    const secretsPath = join(tmpDir, 'secrets.json');
    await writeFile(secretsPath, JSON.stringify({ anthropicApiKey: 'sk-test-key' }));

    const cfg = await loadConfig({ configPath, secretsPath });

    expect(cfg.agents.custom).toBeDefined();
    expect(cfg.agents.custom.model).toBe('claude-haiku-3');
    expect(cfg.agents.custom.systemPrompt).toBe('Custom prompt');
    // Defaults should still be merged for missing fields
    expect(cfg.agents.default).toBeDefined();
  });

  it('reads secrets and unlinks the file', async () => {
    const secretsPath = join(tmpDir, 'secrets.json');
    await writeFile(
      secretsPath,
      JSON.stringify({
        anthropicApiKey: 'sk-from-secrets',
        managementToken: 'mgmt-tok',
        chatToken: 'chat-tok',
      }),
    );

    expect(existsSync(secretsPath)).toBe(true);

    const cfg = await loadConfig({ secretsPath });

    expect(cfg.anthropicApiKey).toBe('sk-from-secrets');
    expect(cfg.managementToken).toBe('mgmt-tok');
    expect(cfg.chatToken).toBe('chat-tok');
    expect(existsSync(secretsPath)).toBe(false);
  });

  it('secrets override env vars', async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-from-env';

    try {
      const secretsPath = join(tmpDir, 'secrets.json');
      await writeFile(secretsPath, JSON.stringify({ anthropicApiKey: 'sk-from-secrets' }));

      const cfg = await loadConfig({ secretsPath });
      expect(cfg.anthropicApiKey).toBe('sk-from-secrets');
    } finally {
      if (original !== undefined) {
        process.env.ANTHROPIC_API_KEY = original;
      } else {
        // biome-ignore lint/performance/noDelete: must actually remove env var, not set to "undefined" string
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it('throws when anthropicApiKey is missing', async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    // biome-ignore lint/performance/noDelete: must actually remove env var, not set to "undefined" string
    delete process.env.ANTHROPIC_API_KEY;

    // Provide secrets file with no API key — this bypasses project credentials loading
    const secretsPath = join(tmpDir, 'empty-secrets.json');
    await writeFile(secretsPath, JSON.stringify({}));

    try {
      await expect(loadConfig({ secretsPath })).rejects.toThrow('Missing ANTHROPIC_API_KEY');
    } finally {
      if (original !== undefined) {
        process.env.ANTHROPIC_API_KEY = original;
      }
    }
  });
});
