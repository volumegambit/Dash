import type { Command } from 'commander';
import { ensureUnlocked, getSecretStore } from '../context.js';

function maskValue(value: string): string {
  if (value.length < 12) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

export function registerSecretsGetCommand(secrets: Command): void {
  secrets
    .command('get <key>')
    .description('Get a stored secret value (masked by default)')
    .option('--reveal', 'Show the full value')
    .action(async (key: string, opts: { reveal?: boolean }) => {
      try {
        await ensureUnlocked();
        const store = getSecretStore();
        const value = await store.get(key);
        if (value === null) {
          console.error(`Secret '${key}' not found.`);
          process.exitCode = 1;
          return;
        }
        console.log(opts.reveal ? value : maskValue(value));
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
