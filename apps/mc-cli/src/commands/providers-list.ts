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
        const keys = await store.list();
        const nameWidth = Math.max(...PROVIDER_METAS.map((p) => p.name.length));
        console.log(`\n  ${'Provider'.padEnd(nameWidth)}  Status`);
        console.log(`  ${'─'.repeat(nameWidth)}  ─────────────`);
        for (const meta of PROVIDER_METAS) {
          const connected = keys.includes(meta.secretKey);
          console.log(
            `  ${meta.name.padEnd(nameWidth)}  ${connected ? 'connected' : 'not connected'}`,
          );
        }
        console.log();
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
