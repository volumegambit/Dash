import { homedir } from 'node:os';
import { join } from 'node:path';
import { ManagementClient } from '@dash/management';
import { AgentConnector, AgentRegistry, FileSecretStore, ProcessRuntime } from '@dash/mc';
import type { SecretStore } from '@dash/mc';

const DATA_DIR = join(homedir(), '.mission-control');

let registry: AgentRegistry | null = null;
let connector: AgentConnector | null = null;
let secretStore: FileSecretStore | null = null;
let runtime: ProcessRuntime | null = null;

export function getRegistry(): AgentRegistry {
  if (!registry) {
    registry = new AgentRegistry(DATA_DIR);
  }
  return registry;
}

export function getSecretStore(): FileSecretStore {
  if (!secretStore) {
    secretStore = new FileSecretStore(DATA_DIR);
  }
  return secretStore;
}

function getConnector(): AgentConnector {
  if (!connector) {
    connector = new AgentConnector(getRegistry(), getSecretStore());
  }
  return connector;
}

export function getRuntime(): ProcessRuntime {
  if (!runtime) {
    const projectRoot = process.env.DASH_PROJECT_ROOT ?? process.cwd();
    runtime = new ProcessRuntime(getRegistry(), getSecretStore(), projectRoot);
  }
  return runtime;
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
