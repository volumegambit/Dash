import type { Command } from 'commander';
import { resolveClient } from '../context.js';

export function registerInfoCommand(program: Command): void {
  program
    .command('info <target>')
    .description('Get info about a Dash agent (target: URL or deployment ID)')
    .option('-t, --token <token>', 'Management API token (required for URL targets)')
    .action(async (target: string, opts: { token?: string }) => {
      try {
        const client = await resolveClient(target, opts.token);
        const info = await client.info();
        console.log(JSON.stringify(info, null, 2));
      } catch (err) {
        console.error(`Failed to reach agent: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
