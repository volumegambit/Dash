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
  getPlatformDataDir,
  migrateLegacyDataDir,
} from '@dash/mc';

const DATA_DIR = getPlatformDataDir('dash');
const LEGACY_DATA_DIR = join(homedir(), '.mission-control');

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
    await migrateLegacyDataDir(LEGACY_DATA_DIR, DATA_DIR);
    const projectRoot = process.env.DASH_PROJECT_ROOT ?? process.cwd();
    runtime = new ProcessRuntime(
      getRegistry(),
      getSecretStore(),
      projectRoot,
      undefined,
      undefined,
      undefined,
      { gatewayDataDir: DATA_DIR },
    );
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

  const prompt = createPrompt();
  try {
    if (await store.needsSetup()) {
      // First-time setup (or migration)
      const password = await prompt.question('Create encryption password: ');
      if (!password) {
        throw new Error('Password is required to set up the secret store.');
      }
      const confirm = await prompt.question('Confirm password: ');
      if (password !== confirm) {
        throw new Error('Passwords do not match.');
      }
      const key = await store.setup(password);
      await keychain.store(key);
    } else {
      // Existing encrypted store — prompt for password
      const password = await prompt.question('Encryption password: ');
      if (!password) {
        throw new Error('Password is required to unlock the secret store.');
      }
      const key = await store.unlockWithPassword(password);
      await keychain.store(key);
    }
  } finally {
    prompt.close();
  }
}

export interface Prompt {
  question(text: string): Promise<string>;
  close(): void;
}

/**
 * Create a line-buffered prompt that works with both TTY and piped stdin.
 * Node's readline.question() drops lines when piped input delivers multiple
 * lines before the next question() call is registered. This buffers lines
 * eagerly so no input is lost.
 */
export function createPrompt(): Prompt {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const buffer: string[] = [];
  let waiting: ((line: string) => void) | null = null;

  rl.on('line', (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line.trim());
    } else {
      buffer.push(line.trim());
    }
  });

  return {
    question(text: string): Promise<string> {
      process.stderr.write(text);
      if (buffer.length > 0) {
        return Promise.resolve(buffer.shift() as string);
      }
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    close() {
      rl.close();
    },
  };
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
