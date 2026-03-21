import type { AgentDeployment } from '../types.js';
import type { RuntimeStatus } from './types.js';

export async function resolveRuntimeStatus(deployment: AgentDeployment): Promise<RuntimeStatus> {
  switch (deployment.status) {
    case 'running':
      return { state: 'running' };
    case 'provisioning':
      return { state: 'starting' };
    case 'error':
      return { state: 'error', error: deployment.errorMessage };
    default:
      return { state: 'stopped' };
  }
}
