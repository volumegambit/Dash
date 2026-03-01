import { createKeychain } from '@dash/mc';
import type { Command } from 'commander';

export function registerLockCommand(program: Command): void {
  program
    .command('lock')
    .description('Clear cached encryption key from OS keychain')
    .action(async () => {
      try {
        const keychain = createKeychain();
        await keychain.clear();
        console.log('Keychain cleared. Next command will prompt for password.');
      } catch (err) {
        console.error(`Lock failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
