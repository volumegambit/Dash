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

    const token =
      deployment.managementToken ?? (await this.secrets.get(`agent-token:${deploymentId}`));
    if (!token) {
      throw new Error(`No management token found for deployment "${deploymentId}"`);
    }

    if (deployment.target === 'local') {
      const port = deployment.managementPort ?? 9100;
      return new ManagementClient(`http://localhost:${port}`, token);
    }

    // Cloud deployments will use SSH tunnel in Phase 4
    // For now, direct connection to droplet IP
    if (!deployment.dropletIp) {
      throw new Error(`No IP address for cloud deployment "${deploymentId}"`);
    }
    const port = deployment.managementPort ?? 9100;
    return new ManagementClient(`http://${deployment.dropletIp}:${port}`, token);
  }
}
