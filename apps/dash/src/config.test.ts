import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgentsFromDirectory, loadConfig, parseFlags } from './config.js';

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
    await writeFile(secretsPath, JSON.stringify({ providerApiKeys: { anthropic: 'sk-test-key' } }));

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
        providerApiKeys: { anthropic: 'sk-from-secrets' },
        managementToken: 'mgmt-tok',
        chatToken: 'chat-tok',
      }),
    );

    expect(existsSync(secretsPath)).toBe(true);

    const cfg = await loadConfig({ secretsPath });

    expect(cfg.providerApiKeys.anthropic).toBe('sk-from-secrets');
    expect(cfg.managementToken).toBe('mgmt-tok');
    expect(cfg.chatToken).toBe('chat-tok');
    expect(existsSync(secretsPath)).toBe(false);
  });

  it('env vars take precedence over secrets for provider API keys', async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-from-env';

    try {
      const secretsPath = join(tmpDir, 'secrets.json');
      await writeFile(
        secretsPath,
        JSON.stringify({ providerApiKeys: { anthropic: 'sk-from-secrets' } }),
      );

      const cfg = await loadConfig({ secretsPath });
      // Resolution order: env vars > secrets > credentials
      expect(cfg.providerApiKeys.anthropic).toBe('sk-from-env');
    } finally {
      if (original !== undefined) {
        process.env.ANTHROPIC_API_KEY = original;
      } else {
        // biome-ignore lint/performance/noDelete: must actually remove env var, not set to "undefined" string
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it('returns empty providerApiKeys when no keys are available', async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    // biome-ignore lint/performance/noDelete: must actually remove env var, not set to "undefined" string
    delete process.env.ANTHROPIC_API_KEY;

    // Provide secrets file with no API keys — this bypasses project credentials loading
    const secretsPath = join(tmpDir, 'empty-secrets.json');
    await writeFile(secretsPath, JSON.stringify({}));

    try {
      const cfg = await loadConfig({ secretsPath });
      expect(cfg.providerApiKeys).toEqual({});
    } finally {
      if (original !== undefined) {
        process.env.ANTHROPIC_API_KEY = original;
      }
    }
  });
});

describe('loadAgentsFromDirectory', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dash-agents-dir-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it('loads agents from individual JSON files', async () => {
    const agentsDir = join(tmpDir, 'agents');
    await mkdir(agentsDir);
    await writeFile(
      join(agentsDir, 'assistant.json'),
      JSON.stringify({ model: 'claude-sonnet-4-20250514', systemPrompt: 'Help users' }),
    );
    await writeFile(
      join(agentsDir, 'coder.json'),
      JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Write code',
        tools: ['bash'],
      }),
    );

    const agents = await loadAgentsFromDirectory(agentsDir);
    expect(agents).not.toBeNull();
    expect(agents?.assistant.systemPrompt).toBe('Help users');
    expect(agents?.coder.tools).toEqual(['bash']);
  });

  it('returns null for non-existent directory', async () => {
    const agents = await loadAgentsFromDirectory(join(tmpDir, 'missing'));
    expect(agents).toBeNull();
  });

  it('returns null for empty directory', async () => {
    const agentsDir = join(tmpDir, 'agents');
    await mkdir(agentsDir);
    const agents = await loadAgentsFromDirectory(agentsDir);
    expect(agents).toBeNull();
  });

  it('uses filename (minus .json) as agent name', async () => {
    const agentsDir = join(tmpDir, 'agents');
    await mkdir(agentsDir);
    await writeFile(
      join(agentsDir, 'my-agent.json'),
      JSON.stringify({ model: 'claude-sonnet-4-20250514', systemPrompt: 'Test' }),
    );

    const agents = await loadAgentsFromDirectory(agentsDir);
    expect(agents).not.toBeNull();
    expect(Object.keys(agents as Record<string, unknown>)).toEqual(['my-agent']);
  });
});

describe('loadConfig with config directory', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dash-configdir-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it('loads agents from agents/ directory when --config is a directory', async () => {
    const configDir = join(tmpDir, 'config');
    const agentsDir = join(configDir, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'bot.json'),
      JSON.stringify({ model: 'claude-sonnet-4-20250514', systemPrompt: 'Bot prompt' }),
    );

    const secretsPath = join(tmpDir, 'secrets.json');
    await writeFile(secretsPath, JSON.stringify({ providerApiKeys: { anthropic: 'sk-test' } }));

    const cfg = await loadConfig({ configPath: configDir, secretsPath });
    expect(cfg.agents.bot).toBeDefined();
    expect(cfg.agents.bot.systemPrompt).toBe('Bot prompt');
    // Default agent should NOT be present — directory agents replace defaults
    expect(cfg.agents.default).toBeUndefined();
  });

  it('agents/ directory overrides dash.json agents key', async () => {
    const configDir = join(tmpDir, 'config');
    const agentsDir = join(configDir, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(configDir, 'dash.json'),
      JSON.stringify({
        agents: {
          fromjson: { model: 'claude-sonnet-4-20250514', systemPrompt: 'From JSON' },
        },
        sessions: { dir: '/tmp/sessions' },
      }),
    );
    await writeFile(
      join(agentsDir, 'fromdir.json'),
      JSON.stringify({ model: 'claude-sonnet-4-20250514', systemPrompt: 'From dir' }),
    );

    const secretsPath = join(tmpDir, 'secrets.json');
    await writeFile(secretsPath, JSON.stringify({ providerApiKeys: { anthropic: 'sk-test' } }));

    const cfg = await loadConfig({ configPath: configDir, secretsPath });
    expect(cfg.agents.fromdir).toBeDefined();
    expect(cfg.agents.fromjson).toBeUndefined();
  });

  it('loads non-agent settings from dash.json in config directory', async () => {
    const configDir = join(tmpDir, 'config');
    const agentsDir = join(configDir, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(configDir, 'dash.json'), JSON.stringify({ logging: { level: 'debug' } }));
    await writeFile(
      join(agentsDir, 'default.json'),
      JSON.stringify({ model: 'claude-sonnet-4-20250514', systemPrompt: 'Test' }),
    );

    const secretsPath = join(tmpDir, 'secrets.json');
    await writeFile(secretsPath, JSON.stringify({ providerApiKeys: { anthropic: 'sk-test' } }));

    const cfg = await loadConfig({ configPath: configDir, secretsPath });
    expect(cfg.logLevel).toBe('debug');
  });

  it('sets configDir when --config is a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dash-cfg-'));
    await writeFile(
      join(dir, 'dash.json'),
      JSON.stringify({
        agents: { default: { model: 'anthropic/m', systemPrompt: 'hi' } },
        logging: { level: 'info' },
      }),
    );
    const cfg = await loadConfig({ configPath: dir });
    expect(cfg.configDir).toBe(dir);
    await rm(dir, { recursive: true });
  });

  it('falls back to dash.json agents when no agents/ directory', async () => {
    const configPath = join(tmpDir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        agents: {
          solo: { model: 'claude-sonnet-4-20250514', systemPrompt: 'Solo agent' },
        },
      }),
    );

    const secretsPath = join(tmpDir, 'secrets.json');
    await writeFile(secretsPath, JSON.stringify({ providerApiKeys: { anthropic: 'sk-test' } }));

    const cfg = await loadConfig({ configPath, secretsPath });
    expect(cfg.agents.solo).toBeDefined();
    expect(cfg.agents.solo.systemPrompt).toBe('Solo agent');
  });
});
