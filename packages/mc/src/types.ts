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
  // Cloud-specific
  dropletId?: number;
  dropletIp?: string;
  region?: string;
}

export interface DeployConfig {
  target: 'local' | 'digitalocean';
  agent: AgentDeployAgentConfig;
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
}
