import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
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

export interface DashJsonConfig {
  agents: Record<string, AgentConfig>;
  sessions: { dir: string };
  logging: { level: string };
}

export interface CredentialsConfig {
  anthropic?: { apiKey?: string };
}

// --- Runtime config (merged JSON + env) ---

export interface DashConfig {
  anthropicApiKey: string;
  agents: Record<string, AgentConfig>;
  sessionDir: string;
  logLevel: string;
  managementPort: number;
  managementToken?: string;
  chatPort: number;
  chatToken?: string;
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

/** Load config from explicit path */
async function loadJsonConfigFromPath(configPath: string): Promise<Partial<DashJsonConfig>> {
  const raw = await readFile(configPath, 'utf-8');
  return JSON.parse(raw) as Partial<DashJsonConfig>;
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

interface SecretsFile {
  anthropicApiKey?: string;
  managementToken?: string;
  chatToken?: string;
}

/** Load secrets from explicit path, then unlink the file */
async function loadSecrets(secretsPath: string): Promise<SecretsFile> {
  const raw = await readFile(secretsPath, 'utf-8');
  const secrets = JSON.parse(raw) as SecretsFile;
  await unlink(secretsPath);
  return secrets;
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

export interface LoadConfigOptions {
  configPath?: string;
  secretsPath?: string;
}

export async function loadConfig(options?: LoadConfigOptions): Promise<DashConfig> {
  // Determine project root (3 levels up from dist/src or src)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(__dirname, '../../..');

  // Load JSON config — explicit path or default search
  const jsonConfig = options?.configPath
    ? await loadJsonConfigFromPath(options.configPath)
    : await loadJsonConfig(projectRoot);

  // Load secrets file if provided (read + unlink)
  const secrets = options?.secretsPath ? await loadSecrets(options.secretsPath) : undefined;

  // Load credentials from project (only if no explicit secrets file)
  const credentials = secrets ? {} : await loadCredentials(projectRoot);

  const merged = deepMerge(DEFAULTS, jsonConfig);

  // Resolve credentials: secrets file > env vars > config/credentials.json
  const anthropicApiKey =
    secrets?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? credentials.anthropic?.apiKey;
  if (!anthropicApiKey) {
    throw new Error(
      'Missing ANTHROPIC_API_KEY. Set it in config/credentials.json or as an env var.',
    );
  }

  // Env overrides for logging
  if (process.env.LOG_LEVEL) {
    merged.logging.level = process.env.LOG_LEVEL;
  }

  // Management API config
  const managementPort = process.env.MANAGEMENT_API_PORT
    ? Number.parseInt(process.env.MANAGEMENT_API_PORT, 10)
    : 9100;
  const managementToken = secrets?.managementToken ?? process.env.MANAGEMENT_API_TOKEN;

  // Chat API config
  const chatPort = process.env.CHAT_API_PORT
    ? Number.parseInt(process.env.CHAT_API_PORT, 10)
    : 9101;
  const chatToken = secrets?.chatToken ?? process.env.CHAT_API_TOKEN;

  return {
    anthropicApiKey,
    agents: merged.agents,
    sessionDir: merged.sessions.dir,
    logLevel: merged.logging.level,
    managementPort,
    managementToken,
    chatPort,
    chatToken,
  };
}

/** Parse --config and --secrets flags from argv */
export function parseFlags(argv: string[]): LoadConfigOptions {
  const options: LoadConfigOptions = {};

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) {
      options.configPath = argv[i + 1];
      i++;
    } else if (argv[i] === '--secrets' && argv[i + 1]) {
      options.secretsPath = argv[i + 1];
      i++;
    }
  }

  return options;
}
