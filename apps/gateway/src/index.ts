import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { startGateway } from './app/bootstrap.js';
import { parseFlags } from './config.js';

const resourceDir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(resourceDir, '../../../.env') });

let stopping: Promise<void> | undefined;
function requestShutdown(reason: string): Promise<void> {
  stopping ??= (async () => {
    console.log(`\nReceived ${reason}, shutting down...`);
    const gateway = await startup;
    await gateway.stop();
    process.exit(0);
  })();
  return stopping;
}

const startup = startGateway(parseFlags(process.argv.slice(2)), { resourceDir, requestShutdown });
startup
  .then(() => {
    process.on('SIGINT', () => void requestShutdown('SIGINT'));
    process.on('SIGTERM', () => void requestShutdown('SIGTERM'));
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
