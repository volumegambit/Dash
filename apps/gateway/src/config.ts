import { readFile, unlink } from 'node:fs/promises';

export interface GatewayRoutingRule {
  condition:
    | { type: 'default' }
    | { type: 'sender'; ids: string[] }
    | { type: 'group'; ids: string[] };
  agentName: string;
  allowList: string[];
  denyList: string[];
}

export interface ChannelConfig {
  adapter: 'telegram' | 'mission-control' | 'whatsapp';
  // Simple mode: route all messages to one agent
  agent?: string;
  // Advanced mode: ordered routing rules
  routing?: GatewayRoutingRule[];
  globalDenyList?: string[];
  // Telegram-specific
  token?: string;
  allowedUsers?: string[];
  // Mission Control-specific
  port?: number;
  // WhatsApp-specific
  authStateDir?: string;
  whatsappAuth?: Record<string, string>;
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
  channels?: Record<string, { token?: string; whatsappAuth?: Record<string, string> }>;
}

export interface LoadConfigOptions {
  configPath?: string;
  secretsPath?: string;
  managementPort?: number;
  channelPort?: number;
  token?: string;
  chatToken?: string;
  dataDir?: string;
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
    } else if (argv[i] === '--management-port' && argv[i + 1]) {
      options.managementPort = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === '--token' && argv[i + 1]) {
      options.token = argv[i + 1];
      i++;
    } else if (argv[i] === '--data-dir' && argv[i + 1]) {
      options.dataDir = argv[i + 1];
      i++;
    } else if (argv[i] === '--channel-port' && argv[i + 1]) {
      options.channelPort = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === '--chat-token' && argv[i + 1]) {
      options.chatToken = argv[i + 1];
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
        if (s.whatsappAuth) {
          config.channels[name].whatsappAuth = s.whatsappAuth;
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
    if (ch.adapter === 'mission-control') continue;

    // WhatsApp channels do not require a token but still need agent reference validation
    if (ch.adapter === 'whatsapp') {
      if (ch.routing) {
        for (const rule of ch.routing) {
          if (!config.agents[rule.agentName]) {
            throw new Error(
              `Channel "${name}" routing rule references unknown agent "${rule.agentName}". Available: ${Object.keys(config.agents).join(', ')}`,
            );
          }
        }
      } else if (!ch.agent || !config.agents[ch.agent]) {
        throw new Error(
          `Channel "${name}" references unknown agent "${ch.agent ?? '(none)'}". Available: ${Object.keys(config.agents).join(', ')}`,
        );
      }
      continue;
    }

    if (ch.routing) {
      // Advanced mode: validate all agentName references
      for (const rule of ch.routing) {
        if (!config.agents[rule.agentName]) {
          throw new Error(
            `Channel "${name}" routing rule references unknown agent "${rule.agentName}". Available: ${Object.keys(config.agents).join(', ')}`,
          );
        }
      }
    } else if (!ch.agent || !config.agents[ch.agent]) {
      // Simple mode: validate agent field
      throw new Error(
        `Channel "${name}" references unknown agent "${ch.agent ?? '(none)'}". Available: ${Object.keys(config.agents).join(', ')}`,
      );
    }
  }

  return config;
}
