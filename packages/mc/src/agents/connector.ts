import { ManagementClient } from '@dash/management';
import type { SecretStore } from '../security/secrets.js';
import type { AgentRegistry } from './registry.js';

export class AgentConnector {
  constructor(
    private registry: AgentRegistry,
    private secrets: SecretStore,
  ) {}

  async getClient(deploymentId: string): Promise<ManagementClient> {
    const deployment = await this.registry.get(deploymentId);
    if (!deployment) {
      throw new Error(`Deployment "${deploymentId}" not found`);
    }

    // TODO: Task 5 will resolve management connection via gateway runtime API.
    // For now, fall back to secret store for token and use default port.
    const token = await this.secrets.get(`agent-token:${deploymentId}`);
    if (!token) {
      throw new Error(`No management token found for deployment "${deploymentId}"`);
    }

    if (deployment.target === 'local') {
      return new ManagementClient('http://localhost:9100', token);
    }

    // Cloud deployments will use SSH tunnel in Phase 4
    if (!deployment.dropletIp) {
      throw new Error(`No IP address for cloud deployment "${deploymentId}"`);
    }
    return new ManagementClient(`http://${deployment.dropletIp}:9100`, token);
  }
}
