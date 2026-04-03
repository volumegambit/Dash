export interface AgentDeployment {
  id: string;
  name: string;
  target: 'local';
  status: 'running' | 'stopped' | 'error' | 'provisioning';
  config: DeployConfig;
  createdAt: string;
  configDir?: string;
  workspace?: string;
  // Startup diagnostics
  startupLogs?: string[]; // captured stdout/stderr from a failed startup
  errorMessage?: string; // human-readable failure reason
  // Credential status
  credentialStatus?: 'ok' | 'missing' | 'invalid';
  credentialProvider?: string;
  credentialDetail?: string;
}

export interface DeployConfig {
  target?: 'local';
  agents?: Record<string, AgentDeployAgentConfig>;
  /** @deprecated Use `agents` instead */
  agent?: AgentDeployAgentConfig;
  channels: Record<string, ChannelDeployConfig>;
}

export interface AgentDeployAgentConfig {
  name: string;
  model: string;
  fallbackModels?: string[];
  systemPrompt: string;
  tools?: string[];
  maxTokens?: number;
  workspace?: string;
  skills?: {
    paths?: string[];
    urls?: string[];
  };
  mcpServers?: import('@dash/mcp').McpServerConfig[];
  credentialKeys?: Record<string, string>;
}

export interface ChannelDeployConfig {
  agent: string;
  allowedUsers?: string[];
  adapter?: string;
  port?: number;
}

export type RoutingCondition =
  | { type: 'default' }
  | { type: 'sender'; ids: string[] }
  | { type: 'group'; ids: string[] };

export interface RoutingRule {
  id: string;
  label?: string;
  condition: RoutingCondition;
  targetAgentName: string;
  allowList: string[]; // empty = allow all matched senders
  denyList: string[]; // always block these senders from this agent
}

export interface MessagingApp {
  id: string;
  name: string; // user-given, e.g. "Family Group Bot"
  type: 'telegram' | 'whatsapp';
  credentialsKey: string; // key in EncryptedSecretStore, e.g. 'messaging-app:abc:token'
  enabled: boolean;
  createdAt: string;
  globalDenyList: string[]; // blocked before any routing evaluates
  routing: RoutingRule[]; // ordered, first match wins
}
