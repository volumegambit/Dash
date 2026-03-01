import type { Command } from 'commander';
import { ensureUnlocked, getSecretStore } from '../context.js';

export function registerSecretsListCommand(secrets: Command): void {
  secrets
    .command('list')
    .description('List all stored secret keys')
    .action(async () => {
      try {
        await ensureUnlocked();
        const store = getSecretStore();
        const keys = await store.list();
        if (keys.length === 0) {
          console.log('No secrets stored.');
          return;
        }
        for (const key of keys) {
          console.log(key);
        }
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
