import { execFile } from 'node:child_process';
import { platform } from 'node:os';

const SERVICE = 'dash-mission-control';
const ACCOUNT = 'encryption-key';

export interface KeychainProvider {
  store(key: Buffer): Promise<void>;
  retrieve(): Promise<Buffer | null>;
  clear(): Promise<void>;
}

// Uses `security -i` (interactive mode) so the key is piped via stdin
// rather than passed as a CLI argument visible in `ps` output.
class MacKeychain implements KeychainProvider {
  async store(key: Buffer): Promise<void> {
    await this.clear();
    const hex = key.toString('hex');
    await execWithStdin(
      'security',
      ['-i'],
      `add-generic-password -s ${SERVICE} -a ${ACCOUNT} -w ${hex}\n`,
    );
  }

  async retrieve(): Promise<Buffer | null> {
    try {
      const hex = await execWithStdin(
        'security',
        ['-i'],
        `find-generic-password -s ${SERVICE} -a ${ACCOUNT} -w\n`,
      );
      if (!hex.trim()) return null;
      return Buffer.from(hex.trim(), 'hex');
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    try {
      await execWithStdin(
        'security',
        ['-i'],
        `delete-generic-password -s ${SERVICE} -a ${ACCOUNT}\n`,
      );
    } catch {
      // Ignore — entry may not exist
    }
  }
}

class LinuxKeychain implements KeychainProvider {
  async store(key: Buffer): Promise<void> {
    await execWithStdin(
      'secret-tool',
      ['store', '--label', SERVICE, 'service', SERVICE, 'account', ACCOUNT],
      key.toString('hex'),
    );
  }

  async retrieve(): Promise<Buffer | null> {
    try {
      const hex = await exec('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]);
      if (!hex.trim()) return null;
      return Buffer.from(hex.trim(), 'hex');
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    try {
      await exec('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT]);
    } catch {
      // Ignore — entry may not exist
    }
  }
}

class NoopKeychain implements KeychainProvider {
  async store(): Promise<void> {}
  async retrieve(): Promise<Buffer | null> {
    return null;
  }
  async clear(): Promise<void> {}
}

export function createKeychain(): KeychainProvider {
  const os = platform();
  if (os === 'darwin') return new MacKeychain();
  if (os === 'linux') return new LinuxKeychain();
  return new NoopKeychain();
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function execWithStdin(cmd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin?.write(input);
    child.stdin?.end();
  });
}
