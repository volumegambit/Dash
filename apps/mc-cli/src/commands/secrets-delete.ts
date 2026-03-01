import type { Command } from 'commander';
import { ensureUnlocked, getSecretStore } from '../context.js';

export function registerSecretsDeleteCommand(secrets: Command): void {
  secrets
    .command('delete <key>')
    .description('Delete a stored secret')
    .action(async (key: string) => {
      try {
        await ensureUnlocked();
        const store = getSecretStore();
        const existing = await store.get(key);
        if (existing === null) {
          console.error(`Secret '${key}' not found.`);
          process.exitCode = 1;
          return;
        }
        await store.delete(key);
        console.log(`Secret '${key}' deleted.`);
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
