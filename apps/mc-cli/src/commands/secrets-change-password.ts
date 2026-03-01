import { createInterface } from 'node:readline';
import { createKeychain } from '@dash/mc';
import type { Command } from 'commander';
import { ensureUnlocked, getSecretStore } from '../context.js';

function promptPassword(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function registerSecretsChangePasswordCommand(secrets: Command): void {
  secrets
    .command('change-password')
    .description('Change the encryption password')
    .action(async () => {
      try {
        await ensureUnlocked();

        const currentPassword = await promptPassword('Current password: ');
        if (!currentPassword) {
          console.error('Current password is required.');
          process.exitCode = 1;
          return;
        }

        const newPassword = await promptPassword('New password: ');
        if (!newPassword) {
          console.error('New password is required.');
          process.exitCode = 1;
          return;
        }

        const confirm = await promptPassword('Confirm new password: ');
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
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
