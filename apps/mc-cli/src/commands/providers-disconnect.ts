import type { Command } from 'commander';
import { createPrompt, ensureUnlocked, getSecretStore } from '../context.js';
import { findProvider } from '../providers.js';

export function registerProvidersDisconnectCommand(providers: Command): void {
  providers
    .command('disconnect <provider>')
    .description('Remove an AI provider API key')
    .option('--key <name>', 'Key name to remove (default: "default")', 'default')
    .option('--all', 'Remove all keys for this provider')
    .action(async (providerArg: string, opts: { key: string; all?: boolean }) => {
      try {
        await ensureUnlocked();
        const meta = findProvider(providerArg);
        if (!meta) {
          console.error(`Unknown provider: ${providerArg}`);
          process.exitCode = 1;
          return;
        }

        const store = getSecretStore();
        const allKeys = await store.list();
        const prefix = `${meta.id}-api-key:`;
        const matchingKeys = allKeys.filter((k) => k.startsWith(prefix));

        if (matchingKeys.length === 0) {
          console.error(`${meta.name} is not connected.`);
          process.exitCode = 1;
          return;
        }

        const prompt = createPrompt();
        try {
          if (opts.all) {
            const answer = await prompt.question(
              `Remove all ${matchingKeys.length} key(s) for ${meta.name}? [y/N]: `,
            );
            if (answer.trim().toLowerCase() !== 'y') {
              console.log('Cancelled.');
              return;
            }
            for (const k of matchingKeys) {
              await store.delete(k);
            }
            console.log(
              `  \u2713 ${meta.name} fully disconnected (${matchingKeys.length} key(s) removed).`,
            );
          } else {
            const targetKey = `${prefix}${opts.key}`;
            if (!matchingKeys.includes(targetKey)) {
              console.error(`No key named "${opts.key}" for ${meta.name}.`);
              console.error(
                `Available keys: ${matchingKeys.map((k) => k.slice(prefix.length)).join(', ')}`,
              );
              process.exitCode = 1;
              return;
            }
            const answer = await prompt.question(
              `Remove "${opts.key}" key for ${meta.name}? [y/N]: `,
            );
            if (answer.trim().toLowerCase() !== 'y') {
              console.log('Cancelled.');
              return;
            }
            await store.delete(targetKey);
            console.log(`  \u2713 ${meta.name} key "${opts.key}" removed.`);
          }
        } finally {
          prompt.close();
        }
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
