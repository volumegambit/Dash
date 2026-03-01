import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ManagementClient } from '@dash/management';
import {
  AgentConnector,
  AgentRegistry,
  EncryptedSecretStore,
  ProcessRuntime,
  createKeychain,
} from '@dash/mc';

const DATA_DIR = join(homedir(), '.mission-control');

let registry: AgentRegistry | null = null;
let connector: AgentConnector | null = null;
let secretStore: EncryptedSecretStore | null = null;
let runtime: ProcessRuntime | null = null;

export function getRegistry(): AgentRegistry {
  if (!registry) {
    registry = new AgentRegistry(DATA_DIR);
  }
  return registry;
}

export function getSecretStore(): EncryptedSecretStore {
  if (!secretStore) {
    secretStore = new EncryptedSecretStore(DATA_DIR);
  }
  return secretStore;
}

async function getConnector(): Promise<AgentConnector> {
  if (!connector) {
    await ensureUnlocked();
    connector = new AgentConnector(getRegistry(), getSecretStore());
  }
  return connector;
}

export async function getRuntime(): Promise<ProcessRuntime> {
  if (!runtime) {
    await ensureUnlocked();
    const projectRoot = process.env.DASH_PROJECT_ROOT ?? process.cwd();
    runtime = new ProcessRuntime(getRegistry(), getSecretStore(), projectRoot);
  }
  return runtime;
}

export async function ensureUnlocked(): Promise<void> {
  const store = getSecretStore();
  if (store.isUnlocked()) return;

  const keychain = createKeychain();

  // Try cached key from OS keychain
  const cachedKey = await keychain.retrieve();
  if (cachedKey) {
    store.unlock(cachedKey);
    try {
      await store.list();
      return;
    } catch {
      // Stale or invalid key — clear and fall through
      store.lock();
      await keychain.clear();
    }
  }

  if (await store.needsSetup()) {
    // First-time setup (or migration)
    const password = await promptPassword('Create encryption password: ');
    if (!password) {
      throw new Error('Password is required to set up the secret store.');
    }
    const confirm = await promptPassword('Confirm password: ');
    if (password !== confirm) {
      throw new Error('Passwords do not match.');
    }
    const key = await store.setup(password);
    await keychain.store(key);
  } else {
    // Existing encrypted store — prompt for password
    const password = await promptPassword('Encryption password: ');
    if (!password) {
      throw new Error('Password is required to unlock the secret store.');
    }
    const key = await store.unlockWithPassword(password);
    await keychain.store(key);
  }
}

function promptPassword(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
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
  const conn = await getConnector();
  return conn.getClient(target);
}
