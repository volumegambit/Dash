import { ManagementClient } from '@dash/management';
import type { Command } from 'commander';

export function registerHealthCommand(program: Command): void {
  program
    .command('health <url>')
    .description('Check health of a Dash agent')
    .requiredOption('-t, --token <token>', 'Management API token')
    .action(async (url: string, opts: { token: string }) => {
      const client = new ManagementClient(url, opts.token);
      try {
        const health = await client.health();
        console.log(JSON.stringify(health, null, 2));
      } catch (err) {
        console.error(`Failed to reach agent: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
