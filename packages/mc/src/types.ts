export interface AgentDeployment {
  id: string;
  name: string;
  target: 'local' | 'digitalocean';
  status: 'running' | 'stopped' | 'error' | 'provisioning';
  config: DeployConfig;
  createdAt: string;
  // Local-specific
  containerId?: string;
  managementPort?: number;
  managementToken?: string;
  // Process-based deployment
  configDir?: string;
  agentServerPid?: number;
  gatewayPid?: number;
  chatPort?: number;
  chatToken?: string;
  workspace?: string;
  // Cloud-specific
  dropletId?: number;
  dropletIp?: string;
  region?: string;
}

export interface DeployConfig {
  target: 'local' | 'digitalocean';
  agents?: Record<string, AgentDeployAgentConfig>;
  /** @deprecated Use `agents` instead */
  agent?: AgentDeployAgentConfig;
  channels: Record<string, ChannelDeployConfig>;
}

export interface AgentDeployAgentConfig {
  name: string;
  model: string;
  systemPrompt: string;
  tools?: string[];
  maxTokens?: number;
  workspace?: string;
}

export interface ChannelDeployConfig {
  agent: string;
  allowedUsers?: string[];
  adapter?: string;
  port?: number;
}
