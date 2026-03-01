import type { Command } from 'commander';
import { getRuntime } from '../context.js';

export function registerRemoveCommand(program: Command): void {
  program
    .command('remove <id>')
    .description('Remove a deployment and clean up its secrets')
    .action(async (id: string) => {
      try {
        const runtime = getRuntime();
        await runtime.remove(id);
        console.log(`Deployment ${id} removed.`);
      } catch (err) {
        console.error(`Remove failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
