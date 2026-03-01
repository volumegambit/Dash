import { homedir } from 'node:os';
import { join } from 'node:path';
import { ManagementClient } from '@dash/management';
import { AgentConnector, AgentRegistry, FileSecretStore } from '@dash/mc';

const DATA_DIR = join(homedir(), '.mission-control');

let registry: AgentRegistry | null = null;
let connector: AgentConnector | null = null;

function getRegistry(): AgentRegistry {
  if (!registry) {
    registry = new AgentRegistry(DATA_DIR);
  }
  return registry;
}

function getConnector(): AgentConnector {
  if (!connector) {
    const secrets = new FileSecretStore(DATA_DIR);
    connector = new AgentConnector(getRegistry(), secrets);
  }
  return connector;
}

/**
 * Resolve a ManagementClient from either a URL + token (ad-hoc)
 * or a deployment ID (registry-based).
 */
export async function resolveClient(target: string, token?: string): Promise<ManagementClient> {
  // If it looks like a URL, use direct mode
  if (target.startsWith('http://') || target.startsWith('https://')) {
    if (!token) {
      throw new Error('--token is required when connecting by URL');
    }
    return new ManagementClient(target, token);
  }

  // Otherwise treat as a deployment ID
  return getConnector().getClient(target);
}
