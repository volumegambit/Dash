import { readFile, unlink } from 'node:fs/promises';

export interface ChannelConfig {
  adapter: 'telegram' | 'mission-control';
  agent?: string; // Required for telegram; unused for mission-control (routes by message content)
  // Telegram-specific
  token?: string;
  allowedUsers?: string[];
  // Mission Control-specific
  port?: number;
}

export interface AgentEndpoint {
  url: string;
  token: string;
}

export interface GatewayConfig {
  channels: Record<string, ChannelConfig>;
  agents: Record<string, AgentEndpoint>;
}

interface SecretsFile {
  agents?: Record<string, { token?: string }>;
  channels?: Record<string, { token?: string }>;
}

export interface LoadConfigOptions {
  configPath?: string;
  secretsPath?: string;
}

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

export async function loadConfig(options?: LoadConfigOptions): Promise<GatewayConfig> {
  const configPath = options?.configPath;
  if (!configPath) {
    throw new Error('Gateway requires --config <path> to a JSON config file.');
  }

  const raw = await readFile(configPath, 'utf-8');
  const config = JSON.parse(raw) as GatewayConfig;

  // Load and merge secrets if provided
  if (options?.secretsPath) {
    const secretsRaw = await readFile(options.secretsPath, 'utf-8');
    const secrets = JSON.parse(secretsRaw) as SecretsFile;
    await unlink(options.secretsPath);

    if (secrets.agents) {
      for (const [name, s] of Object.entries(secrets.agents)) {
        if (config.agents[name] && s.token) {
          config.agents[name].token = s.token;
        }
      }
    }
    if (secrets.channels) {
      for (const [name, s] of Object.entries(secrets.channels)) {
        if (config.channels[name] && s.token) {
          config.channels[name].token = s.token;
        }
      }
    }
  }

  // Validate
  if (!config.channels || Object.keys(config.channels).length === 0) {
    throw new Error('Gateway config must define at least one channel.');
  }
  if (!config.agents || Object.keys(config.agents).length === 0) {
    throw new Error('Gateway config must define at least one agent.');
  }

  for (const [name, ch] of Object.entries(config.channels)) {
    if (ch.adapter === 'mission-control') continue; // MC routes by message content
    if (!ch.agent || !config.agents[ch.agent]) {
      throw new Error(
        `Channel "${name}" references unknown agent "${ch.agent ?? '(none)'}". Available: ${Object.keys(config.agents).join(', ')}`,
      );
    }
  }

  return config;
}
