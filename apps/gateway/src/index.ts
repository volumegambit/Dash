import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

import { loadConfig, parseFlags } from './config.js';
import { createGateway } from './gateway.js';

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const gatewayConfig = await loadConfig(flags);
  const gateway = createGateway(gatewayConfig);

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await gateway.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await gateway.start();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
