import type { Command } from 'commander';
import { createPrompt, ensureUnlocked, getSecretStore } from '../context.js';
import { PROVIDER_METAS, findProvider } from '../providers.js';

export function registerProvidersConnectCommand(providers: Command): void {
  providers
    .command('connect [provider]')
    .description('Add or update an API key for an AI provider')
    .action(async (providerArg: string | undefined) => {
      try {
        await ensureUnlocked();
        const prompt = createPrompt();
        try {
          let meta = providerArg ? findProvider(providerArg) : undefined;

          if (providerArg && !meta) {
            console.error(`Unknown provider: ${providerArg}`);
            console.error(`Available: ${PROVIDER_METAS.map((p) => p.id).join(', ')}`);
            process.exitCode = 1;
            return;
          }

          if (!meta) {
            console.log('\nChoose an AI provider:\n');
            PROVIDER_METAS.forEach((p, i) => console.log(`  ${i + 1}. ${p.name}`));
            console.log();
            const choice = await prompt.question('Enter number: ');
            const idx = Number.parseInt(choice, 10) - 1;
            if (Number.isNaN(idx) || idx < 0 || idx >= PROVIDER_METAS.length) {
              console.error('Invalid choice.');
              process.exitCode = 1;
              return;
            }
            meta = PROVIDER_METAS[idx];
          }

          console.log(`\nConnecting to ${meta.name}`);
          console.log(`Console:  ${meta.consoleUrl}`);
          console.log(`API Keys: ${meta.apiKeysUrl}`);
          console.log();
          meta.steps.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
          console.log();

          const key = await prompt.question(`Paste your API key (${meta.placeholder}): `);
          if (!key.trim()) {
            console.error('API key is required.');
            process.exitCode = 1;
            return;
          }

          const store = getSecretStore();
          await store.set(meta.secretKey, key.trim());
          console.log(`\n  ✓ ${meta.name} connected.\n`);
        } finally {
          prompt.close();
        }
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
