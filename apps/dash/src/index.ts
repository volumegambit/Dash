import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });
import { createAgentServer } from './agent-server.js';
import { loadConfig, parseFlags } from './config.js';

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const cfg = await loadConfig(flags);
  const server = await createAgentServer(cfg);

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.start();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
