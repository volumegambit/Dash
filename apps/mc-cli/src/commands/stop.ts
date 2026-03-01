import type { Command } from 'commander';
import { getRuntime } from '../context.js';

export function registerStopCommand(program: Command): void {
  program
    .command('stop <id>')
    .description('Stop a running deployment')
    .action(async (id: string) => {
      try {
        const runtime = getRuntime();
        await runtime.stop(id);
        console.log(`Deployment ${id} stopped.`);
      } catch (err) {
        console.error(`Stop failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
