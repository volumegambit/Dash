import { createConsoleLogger } from '@dash/logging';
import { credentialStoreAuth, staticRelayAuth } from './auth.js';
import { loadRelayConfig } from './config.js';
import { PairingCredentialStore } from './credential-store.js';
import { type RelayServerOptions, createRelayServer } from './relay-server.js';

/**
 * Executable entrypoint for the relay server. Kept separate from index.ts (the
 * side-effect-free library barrel) so importing `@dash/relay` never starts a
 * server. Run with `node dist/main.js` (or `npm run -w @dash/relay dev`).
 */
async function main(): Promise<void> {
  const config = loadRelayConfig({ argv: process.argv.slice(2), env: process.env });
  const logger = createConsoleLogger('info', 'text', 'relay');

  // The shared relay token always gates gateway registration. When an admin
  // secret is configured, the relay also validates real per-pairing credentials
  // (provisioned/revoked via /admin/*); otherwise pairing credentials are
  // accepted permissively (dev mode — gateway tokens remain the real auth).
  let options: RelayServerOptions = {};
  let deps = staticRelayAuth(config.relayToken);
  if (config.adminSecret) {
    const store = new PairingCredentialStore();
    deps = credentialStoreAuth(config.relayToken, store);
    options = { admin: { secret: config.adminSecret, store } };
  }
  const relay = createRelayServer(deps, options);

  await new Promise<void>((resolve) => {
    relay.httpServer.listen(config.port, config.host, () => resolve());
  });
  logger.info(`relay listening on ${config.host}:${config.port}`);
  logger.info(`admin API ${config.adminSecret ? 'enabled' : 'disabled'}`);

  // Last-resort net for a multi-tenant relay: the per-stream code already
  // isolates faults (see routeFromGateway), but a relay must not take every
  // tenant down on one unforeseen throw. Log and keep serving rather than exit.
  process.on('uncaughtException', (err) => {
    logger.error(`uncaught exception (kept alive): ${err instanceof Error ? err.stack : err}`);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(`unhandled rejection (kept alive): ${String(reason)}`);
  });

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
