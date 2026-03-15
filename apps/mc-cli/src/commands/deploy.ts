import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { ensureUnlocked, getRegistry, getRuntime, getSecretStore } from '../context.js';

async function promptSecret(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

interface GatewayJsonChannels {
  channels?: Record<string, { adapter?: string }>;
}

export function registerDeployCommand(program: Command): void {
  program
    .command('deploy <config-dir>')
    .description('Deploy an agent from a config directory')
    .action(async (configDir: string) => {
      try {
        const absConfigDir = resolve(configDir);
        await ensureUnlocked();
        const secrets = getSecretStore();

        // Check for Anthropic API key
        let apiKey = await secrets.get('anthropic-api-key:default');
        if (!apiKey) {
          apiKey = await promptSecret('Anthropic API key: ');
          if (!apiKey) {
            console.error('Anthropic API key is required.');
            process.exitCode = 1;
            return;
          }
          await secrets.set('anthropic-api-key:default', apiKey);
          console.error('Stored Anthropic API key.');
        }

        // Check gateway.json for channel secrets
        const gatewayJsonPath = join(absConfigDir, 'gateway.json');
        if (existsSync(gatewayJsonPath)) {
          const raw = await readFile(gatewayJsonPath, 'utf-8');
          const gatewayJson = JSON.parse(raw) as GatewayJsonChannels;
          if (gatewayJson.channels) {
            for (const [, ch] of Object.entries(gatewayJson.channels)) {
              if (ch.adapter === 'telegram') {
                let botToken = await secrets.get('telegram-bot-token');
                if (!botToken) {
                  botToken = await promptSecret('Telegram bot token: ');
                  if (botToken) {
                    await secrets.set('telegram-bot-token', botToken);
                    console.error('Stored Telegram bot token.');
                  }
                }
              }
            }
          }
        }

        // Deploy
        const runtime = await getRuntime();

        // Show spinner while deploying
        let dots = 0;
        const spinner = setInterval(() => {
          dots = (dots + 1) % 4;
          process.stderr.write(`\rDeploying${'.'.repeat(dots)}   `);
        }, 400);

        let id: string;
        try {
          id = await runtime.deploy(absConfigDir);
        } catch (err) {
          clearInterval(spinner);
          process.stderr.write('\r                    \r'); // clear spinner line

          const { DeploymentStartupError } = await import('@dash/mc');
          if (err instanceof DeploymentStartupError) {
            const deployment = await getRegistry().get(err.deploymentId);
            console.error(`✗ Deploy failed: ${err.message}`);
            if (deployment?.startupLogs?.length) {
              console.error('\n--- Agent server startup logs ---');
              for (const line of deployment.startupLogs) {
                console.error(line);
              }
              console.error('---------------------------------\n');
            }
          } else {
            console.error(`Deploy failed: ${(err as Error).message}`);
          }
          process.exitCode = 1;
          return;
        }

        clearInterval(spinner);
        process.stderr.write('\r                    \r'); // clear spinner line

        const status = await runtime.getStatus(id);
        console.log(`✓ Deployment ${id} started`);
        if (status.managementPort)
          console.log(`  Management API: http://localhost:${status.managementPort}`);
        if (status.chatPort) console.log(`  Chat API: ws://localhost:${status.chatPort}/ws`);
        if (status.agentServerPid) console.log(`  Agent server PID: ${status.agentServerPid}`);
      } catch (err) {
        console.error(`Deploy failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
