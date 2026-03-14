import type { Command } from 'commander';
import { ensureUnlocked, getSecretStore } from '../context.js';
import { PROVIDER_METAS } from '../providers.js';

export function registerProvidersListCommand(providers: Command): void {
  providers
    .command('list')
    .description('Show connection status for all AI providers')
    .action(async () => {
      try {
        await ensureUnlocked();
        const store = getSecretStore();
        const allKeys = await store.list();
        const nameWidth = Math.max(...PROVIDER_METAS.map((p) => p.name.length));
        console.log(`\n  ${'Provider'.padEnd(nameWidth)}  Status`);
        console.log(`  ${'─'.repeat(nameWidth)}  ─────────────`);
        for (const meta of PROVIDER_METAS) {
          const prefix = `${meta.id}-api-key:`;
          const keyNames = allKeys
            .filter((k) => k.startsWith(prefix))
            .map((k) => k.slice(prefix.length));
          if (keyNames.length === 0) {
            console.log(`  ${meta.name.padEnd(nameWidth)}  not connected`);
          } else {
            console.log(`  ${meta.name.padEnd(nameWidth)}  connected (${keyNames.join(', ')})`);
          }
        }
        console.log();
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
