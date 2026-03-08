export interface RegisterAgentRequest {
  deploymentId: string;
  agentName: string;
  chatUrl: string;
  chatToken: string;
}

export interface ChannelRoutingRule {
  condition:
    | { type: 'default' }
    | { type: 'sender'; ids: string[] }
    | { type: 'group'; ids: string[] };
  agentName: string;
  allowList: string[];
  denyList: string[];
}

export interface ChannelRegistrationConfig {
  adapter: 'telegram' | 'whatsapp';
  token?: string;
  authStateDir?: string;
  whatsappAuth?: Record<string, string>;
  globalDenyList?: string[];
  routing: ChannelRoutingRule[];
}

export interface RegisterChannelRequest {
  deploymentId: string;
  channelName: string;
  config: ChannelRegistrationConfig;
}

export interface AgentRegistration {
  agentName: string;
  chatUrl: string;
  chatToken: string;
}

export interface DeploymentRegistration {
  deploymentId: string;
  agents: AgentRegistration[];
  channels: RegisterChannelRequest[];
}

export interface GatewayHealthResponse {
  status: 'healthy';
  startedAt: string;
  agents: number;
  channels: number;
}
