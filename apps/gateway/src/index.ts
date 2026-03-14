import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

import { serve } from '@hono/node-server';
import { loadConfig, parseFlags } from './config.js';
import { createDynamicGateway, createGateway } from './gateway.js';
import { createGatewayManagementApp } from './management-api.js';

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.configPath) {
    // Static mode — existing behavior unchanged
    const gatewayConfig = await loadConfig(flags);
    const gateway = createGateway(gatewayConfig);

    const shutdown = async (signal: string) => {
      console.log(`\nReceived ${signal}, shutting down...`);
      await gateway.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => {
      shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
      shutdown('SIGTERM');
    });

    await gateway.start();
  } else {
    // Daemon mode — shared gateway with management API
    const managementPort = flags.managementPort ?? 9300;
    const startedAt = new Date().toISOString();

    // Ensure data dir exists if specified
    if (flags.dataDir) {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(flags.dataDir, { recursive: true });
    }

    const gateway = createDynamicGateway();
    const app = createGatewayManagementApp(gateway, startedAt, flags.token);

    const server = serve({
      fetch: app.fetch,
      port: managementPort,
      hostname: '127.0.0.1',
    });

    console.log(`Gateway management API listening on port ${managementPort}`);
    console.log('Server ready');

    const shutdown = async (signal: string) => {
      console.log(`\nReceived ${signal}, shutting down...`);
      await gateway.stop();
      server.close();
      process.exit(0);
    };

    process.on('SIGINT', () => {
      shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
      shutdown('SIGTERM');
    });
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
