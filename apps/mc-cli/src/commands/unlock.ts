import type { Command } from 'commander';
import { ensureUnlocked } from '../context.js';

export function registerUnlockCommand(program: Command): void {
  program
    .command('unlock')
    .description('Unlock the encrypted secret store')
    .action(async () => {
      try {
        await ensureUnlocked();
        console.log('Secret store unlocked.');
      } catch (err) {
        console.error(`Unlock failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
