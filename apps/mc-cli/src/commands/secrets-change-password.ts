import { createKeychain } from '@dash/mc';
import type { Command } from 'commander';
import { createPrompt, ensureUnlocked, getSecretStore } from '../context.js';

export function registerSecretsChangePasswordCommand(secrets: Command): void {
  secrets
    .command('change-password')
    .description('Change the encryption password')
    .action(async () => {
      try {
        await ensureUnlocked();

        const prompt = createPrompt();
        try {
          const currentPassword = await prompt.question('Current password: ');
          if (!currentPassword) {
            console.error('Current password is required.');
            process.exitCode = 1;
            return;
          }

          const newPassword = await prompt.question('New password: ');
          if (!newPassword) {
            console.error('New password is required.');
            process.exitCode = 1;
            return;
          }

          const confirm = await prompt.question('Confirm new password: ');
          if (newPassword !== confirm) {
            console.error('Passwords do not match.');
            process.exitCode = 1;
            return;
          }

          const store = getSecretStore();
          const newKey = await store.changePassword(currentPassword, newPassword);

          // Update keychain cache with new key
          const keychain = createKeychain();
          await keychain.store(newKey);

          console.log('Password changed successfully.');
        } finally {
          prompt.close();
        }
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
