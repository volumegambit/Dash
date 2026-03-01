import type { Command } from 'commander';
import { resolveClient } from '../context.js';

export function registerHealthCommand(program: Command): void {
  program
    .command('health <target>')
    .description('Check health of a Dash agent (target: URL or deployment ID)')
    .option('-t, --token <token>', 'Management API token (required for URL targets)')
    .action(async (target: string, opts: { token?: string }) => {
      try {
        const client = await resolveClient(target, opts.token);
        const health = await client.health();
        console.log(JSON.stringify(health, null, 2));
      } catch (err) {
        console.error(`Failed to reach agent: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
