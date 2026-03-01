import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentSecretsFile,
  type GatewaySecretsFile,
  buildGatewayConfig,
  findAvailablePort,
  validateConfigDir,
  writeSecretsFile,
} from './process.js';

describe('findAvailablePort', () => {
  it('returns a valid port number', async () => {
    const port = await findAvailablePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('returns different ports on successive calls', async () => {
    const [p1, p2] = await Promise.all([findAvailablePort(), findAvailablePort()]);
    expect(p1).not.toBe(p2);
  });
});

describe('validateConfigDir', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mc-validate-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it('rejects non-existent directory', () => {
    expect(() => validateConfigDir('/nonexistent/path')).toThrow('does not exist');
  });

  it('rejects path that is a file', async () => {
    const filePath = join(tmpDir, 'not-a-dir.json');
    await writeFile(filePath, '{}');
    expect(() => validateConfigDir(filePath)).toThrow('not a directory');
  });

  it('rejects directory without agents/ or dash.json', () => {
    expect(() => validateConfigDir(tmpDir)).toThrow('must contain agents/ directory or dash.json');
  });

  it('accepts directory with agents/ subdirectory', async () => {
    await mkdir(join(tmpDir, 'agents'));
    expect(() => validateConfigDir(tmpDir)).not.toThrow();
  });

  it('accepts directory with dash.json', async () => {
    await writeFile(join(tmpDir, 'dash.json'), '{}');
    expect(() => validateConfigDir(tmpDir)).not.toThrow();
  });
});

describe('writeSecretsFile', () => {
  it('writes agent secrets with 0600 permissions', async () => {
    const secrets: AgentSecretsFile = {
      anthropicApiKey: 'sk-test',
      managementToken: 'mgmt-tok',
      chatToken: 'chat-tok',
    };

    const filePath = await writeSecretsFile(secrets, 'test-agent');
    try {
      expect(existsSync(filePath)).toBe(true);

      const content = JSON.parse(await readFile(filePath, 'utf-8'));
      expect(content.anthropicApiKey).toBe('sk-test');
      expect(content.managementToken).toBe('mgmt-tok');
      expect(content.chatToken).toBe('chat-tok');

      const stats = statSync(filePath);
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      await rm(filePath);
    }
  });

  it('writes gateway secrets with correct shape', async () => {
    const secrets: GatewaySecretsFile = {
      agents: { default: { token: 'agent-tok' } },
      channels: { telegram: { token: 'bot-tok' } },
    };

    const filePath = await writeSecretsFile(secrets, 'test-gw');
    try {
      const content = JSON.parse(await readFile(filePath, 'utf-8'));
      expect(content.agents.default.token).toBe('agent-tok');
      expect(content.channels.telegram.token).toBe('bot-tok');
    } finally {
      await rm(filePath);
    }
  });
});

describe('buildGatewayConfig', () => {
  it('generates config with MC adapter when no gateway.json', () => {
    const config = buildGatewayConfig(['default'], 9101, 9102);

    expect(config.agents).toEqual({
      default: { url: 'ws://localhost:9101/ws', token: 'PLACEHOLDER' },
    });
    expect((config.channels as Record<string, { adapter: string }>).mc.adapter).toBe(
      'mission-control',
    );
  });

  it('includes all agents in config', () => {
    const config = buildGatewayConfig(['agent-a', 'agent-b'], 9101, 9102);

    const agents = config.agents as Record<string, { url: string }>;
    expect(Object.keys(agents)).toEqual(['agent-a', 'agent-b']);
  });

  it('preserves telegram channel from gateway.json', () => {
    const config = buildGatewayConfig(['default'], 9101, 9102, {
      channels: {
        telegram: { adapter: 'telegram', agent: 'default' },
      },
    });

    const channels = config.channels as Record<string, { adapter: string }>;
    expect(channels.telegram.adapter).toBe('telegram');
    // MC adapter auto-added
    expect(channels.mc.adapter).toBe('mission-control');
  });

  it('uses allocated MC adapter port', () => {
    const config = buildGatewayConfig(['default'], 9101, 9999);

    const channels = config.channels as Record<string, { port?: number }>;
    expect(channels.mc.port).toBe(9999);
  });

  it('does not duplicate MC adapter if already in gateway.json', () => {
    const config = buildGatewayConfig(['default'], 9101, 9102, {
      channels: {
        'my-mc': { adapter: 'mission-control', agent: 'default' },
      },
    });

    const channels = config.channels as Record<string, { adapter: string }>;
    expect(channels['my-mc'].adapter).toBe('mission-control');
    expect(channels.mc).toBeUndefined();
  });
});
