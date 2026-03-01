import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- JSON config schema ---

export interface AgentConfig {
  model: string;
  systemPrompt: string;
  tools?: string[];
  maxTokens?: number;
  workspace?: string;
  thinking?: { budgetTokens: number };
}

export interface ChannelConfig {
  agent: string;
  allowedUsers?: string[];
}

export interface DashJsonConfig {
  agents: Record<string, AgentConfig>;
  channels: Record<string, ChannelConfig>;
  sessions: { dir: string };
  logging: { level: string };
}

export interface CredentialsConfig {
  anthropic?: { apiKey?: string };
  telegram?: { botToken?: string };
}

// --- Runtime config (merged JSON + env) ---

export interface DashConfig {
  anthropicApiKey: string;
  telegramBotToken: string;
  agents: Record<string, AgentConfig>;
  channels: Record<string, ChannelConfig>;
  sessionDir: string;
  logLevel: string;
  managementPort: number;
  managementToken?: string;
}

const DEFAULTS: DashJsonConfig = {
  agents: {
    default: {
      model: 'claude-sonnet-4-20250514',
      systemPrompt:
        'You are Dash, a helpful AI assistant. You can use tools to help accomplish tasks.',
      tools: ['bash', 'read_file'],
      maxTokens: 4096,
      workspace: './data/workspace',
    },
  },
  channels: {
    telegram: { agent: 'default', allowedUsers: [] },
  },
  sessions: { dir: './data/sessions' },
  logging: { level: 'info' },
};

/** Search for config/dash.json or dash.json relative to project root */
async function loadJsonConfig(projectRoot: string): Promise<Partial<DashJsonConfig>> {
  const candidates = [resolve(projectRoot, 'config/dash.json'), resolve(projectRoot, 'dash.json')];

  for (const path of candidates) {
    if (existsSync(path)) {
      const raw = await readFile(path, 'utf-8');
      return JSON.parse(raw) as Partial<DashJsonConfig>;
    }
  }

  return {};
}

/** Search for config/credentials.json or credentials.json relative to project root */
async function loadCredentials(projectRoot: string): Promise<CredentialsConfig> {
  const candidates = [
    resolve(projectRoot, 'config/credentials.json'),
    resolve(projectRoot, 'credentials.json'),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      const raw = await readFile(path, 'utf-8');
      return JSON.parse(raw) as CredentialsConfig;
    }
  }

  return {};
}

/** Deep merge: b overrides a, arrays are replaced not merged */
function deepMerge<T extends Record<string, unknown>>(a: T, b: Partial<T>): T {
  const result = { ...a };
  for (const key of Object.keys(b) as (keyof T)[]) {
    const bVal = b[key];
    if (bVal === undefined) continue;
    const aVal = result[key];
    if (
      aVal &&
      bVal &&
      typeof aVal === 'object' &&
      typeof bVal === 'object' &&
      !Array.isArray(aVal) &&
      !Array.isArray(bVal)
    ) {
      result[key] = deepMerge(
        aVal as Record<string, unknown>,
        bVal as Record<string, unknown>,
      ) as T[keyof T];
    } else {
      result[key] = bVal as T[keyof T];
    }
  }
  return result;
}

export async function loadConfig(): Promise<DashConfig> {
  // Determine project root (3 levels up from dist/src or src)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(__dirname, '../../..');

  const [jsonConfig, credentials] = await Promise.all([
    loadJsonConfig(projectRoot),
    loadCredentials(projectRoot),
  ]);
  const merged = deepMerge(DEFAULTS, jsonConfig);

  // Resolve credentials: env vars override config/credentials.json
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? credentials.anthropic?.apiKey;
  if (!anthropicApiKey) {
    throw new Error(
      'Missing ANTHROPIC_API_KEY. Set it in config/credentials.json or as an env var.',
    );
  }

  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN ?? credentials.telegram?.botToken;
  if (!telegramBotToken) {
    throw new Error(
      'Missing TELEGRAM_BOT_TOKEN. Set it in config/credentials.json or as an env var.',
    );
  }

  // Env overrides for channel-level settings
  const envAllowedUsers = process.env.TELEGRAM_ALLOWED_USERS;
  if (envAllowedUsers && merged.channels.telegram) {
    merged.channels.telegram.allowedUsers = envAllowedUsers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Env overrides for logging
  if (process.env.LOG_LEVEL) {
    merged.logging.level = process.env.LOG_LEVEL;
  }

  // Management API config
  const managementPort = process.env.MANAGEMENT_API_PORT
    ? Number.parseInt(process.env.MANAGEMENT_API_PORT, 10)
    : 9100;
  const managementToken = process.env.MANAGEMENT_API_TOKEN;

  return {
    anthropicApiKey,
    telegramBotToken,
    agents: merged.agents,
    channels: merged.channels,
    sessionDir: merged.sessions.dir,
    logLevel: merged.logging.level,
    managementPort,
    managementToken,
  };
}
