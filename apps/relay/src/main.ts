import { createConsoleLogger } from '@dash/logging';
import { staticRelayAuth } from './auth.js';
import { loadRelayConfig } from './config.js';
import { createRelayServer } from './relay-server.js';

/**
 * Executable entrypoint for the relay server. Kept separate from index.ts (the
 * side-effect-free library barrel) so importing `@dash/relay` never starts a
 * server. Run with `node dist/main.js` (or `npm run -w @dash/relay dev`).
 */
async function main(): Promise<void> {
  const config = loadRelayConfig({ argv: process.argv.slice(2), env: process.env });
  const logger = createConsoleLogger('info', 'text', 'relay');

  // v1 admission: one shared relay token gates gateway registration. Real
  // per-pairing credentials with revocation land in R10.
  const relay = createRelayServer(staticRelayAuth(config.relayToken));

  await new Promise<void>((resolve) => {
    relay.httpServer.listen(config.port, config.host, () => resolve());
  });
  logger.info(`relay listening on ${config.host}:${config.port}`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`received ${signal}, shutting down`);
    await relay.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
