import type { Command } from 'commander';
import { getRuntime } from '../context.js';

export function registerLogsCommand(program: Command): void {
  program
    .command('logs <id>')
    .description('Stream logs from a running deployment')
    .action(async (id: string) => {
      try {
        const runtime = await getRuntime();
        for await (const line of runtime.getLogs(id)) {
          process.stdout.write(`${line}\n`);
        }
      } catch (err) {
        console.error(`Logs failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
