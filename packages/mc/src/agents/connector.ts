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

    const token = await this.secrets.get(`agent-token:${deploymentId}`);
    if (!token) {
      throw new Error(`No management token found for deployment "${deploymentId}"`);
    }

    return new ManagementClient('http://localhost:9100', token);
  }
}
