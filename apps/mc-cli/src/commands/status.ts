import type { Command } from 'commander';
import { getRegistry, getRuntime } from '../context.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status [id]')
    .description('List deployments or show detailed status for a deployment')
    .action(async (id?: string) => {
      try {
        if (id) {
          const runtime = await getRuntime();
          const status = await runtime.getStatus(id);
          console.log(`Deployment: ${id}`);
          console.log(`  State: ${status.state}`);
          if (status.uptime != null) {
            const secs = Math.floor(status.uptime / 1000);
            console.log(`  Uptime: ${secs}s`);
          }
          if (status.error) console.log(`  Error: ${status.error}`);
        } else {
          const registry = getRegistry();
          const deployments = await registry.list();
          if (deployments.length === 0) {
            console.log('No deployments.');
            return;
          }
          for (const d of deployments) {
            console.log(`${d.id}  ${d.name}  ${d.status}  ${d.createdAt}`);
          }
        }
      } catch (err) {
        console.error(`Status failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
