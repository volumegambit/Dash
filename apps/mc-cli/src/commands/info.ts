import { ManagementClient } from '@dash/management';
import type { Command } from 'commander';

export function registerInfoCommand(program: Command): void {
  program
    .command('info <url>')
    .description('Get info about a Dash agent')
    .requiredOption('-t, --token <token>', 'Management API token')
    .action(async (url: string, opts: { token: string }) => {
      const client = new ManagementClient(url, opts.token);
      try {
        const info = await client.info();
        console.log(JSON.stringify(info, null, 2));
      } catch (err) {
        console.error(`Failed to reach agent: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
