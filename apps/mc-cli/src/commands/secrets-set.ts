import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { ensureUnlocked, getSecretStore } from '../context.js';

export function registerSecretsSetCommand(secrets: Command): void {
  secrets
    .command('set <key>')
    .description('Store a secret value')
    .option('--value <val>', 'Secret value (prompts interactively if omitted)')
    .action(async (key: string, opts: { value?: string }) => {
      try {
        await ensureUnlocked();
        let value = opts.value;
        if (!value) {
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          value = await new Promise<string>((resolve) => {
            rl.question(`Value for '${key}': `, (answer) => {
              rl.close();
              resolve(answer.trim());
            });
          });
        }
        if (!value) {
          console.error('Value is required.');
          process.exitCode = 1;
          return;
        }
        const store = getSecretStore();
        await store.set(key, value);
        console.log(`Secret '${key}' stored.`);
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
