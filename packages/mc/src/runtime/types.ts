export interface RuntimeStatus {
  state: 'running' | 'stopped' | 'error' | 'starting';
  agentServerPid?: number;
  gatewayPid?: number;
  managementPort?: number;
  chatPort?: number;
  uptime?: number;
  error?: string;
}

export interface DeploymentRuntime {
  deploy(configDir: string): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  getStatus(id: string): Promise<RuntimeStatus>;
  getLogs(id: string): AsyncIterable<string>;
}
