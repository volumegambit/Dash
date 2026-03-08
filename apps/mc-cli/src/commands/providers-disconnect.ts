import type { Command } from 'commander';
import { createPrompt, ensureUnlocked, getSecretStore } from '../context.js';
import { findProvider } from '../providers.js';

export function registerProvidersDisconnectCommand(providers: Command): void {
  providers
    .command('disconnect <provider>')
    .description('Remove an AI provider API key')
    .action(async (providerArg: string) => {
      try {
        await ensureUnlocked();
        const meta = findProvider(providerArg);
        if (!meta) {
          console.error(`Unknown provider: ${providerArg}`);
          process.exitCode = 1;
          return;
        }

        const store = getSecretStore();
        const keys = await store.list();
        if (!keys.includes(meta.secretKey)) {
          console.error(`${meta.name} is not connected.`);
          process.exitCode = 1;
          return;
        }

        const prompt = createPrompt();
        try {
          const answer = await prompt.question(
            `Disconnect ${meta.name}? This removes the API key. [y/N]: `,
          );
          if (answer.trim().toLowerCase() !== 'y') {
            console.log('Cancelled.');
            return;
          }
          await store.delete(meta.secretKey);
          console.log(`  ✓ ${meta.name} disconnected.`);
        } finally {
          prompt.close();
        }
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
