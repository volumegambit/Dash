import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConsoleLogger } from '@dash/logging';
import { serve } from '@hono/node-server';
import { createApi } from './api.js';
import { type Authenticator, StubAuthenticator } from './auth.js';
import { loadConfig } from './config.js';
import { DialTokenSigner } from './dial-token-signer.js';
import { ProvisioningService } from './provisioning.js';
import { RelayAdminClient } from './relay-admin-client.js';
import { SqliteStore } from './store.js';

/**
 * Executable entrypoint for the control plane. Kept separate from index.ts (the
 * side-effect-free barrel) so importing `@dash/relay-control-plane` never starts
 * a server. Run with `node dist/main.js`.
 */
async function main(): Promise<void> {
  const config = loadConfig({ argv: process.argv.slice(2), env: process.env });
  const logger = createConsoleLogger('info', 'text', 'relay-control-plane');

  const store = new SqliteStore(config.dbPath);
  const privateKey = createPrivateKey(readFileSync(config.dialTokenPrivateKeyPath, 'utf8'));
  const signer = new DialTokenSigner(privateKey, config.dialTokenTtlSec);
  const relay = new RelayAdminClient(config.relayAdminUrl, config.relayAdminSecret);
  const provisioning = new ProvisioningService({
    store,
    signer,
    relay,
    relayZone: config.relayZone,
  });

  // Authenticator selection. WorkOS is the production identity provider, but the
  // identity-independent core ships first: until the WorkOS adapter lands, the
  // dev StubAuthenticator (trusts an `x-test-account` header) is wired behind an
  // explicit opt-in flag so it can never be enabled in production by accident.
  //
  // TODO: WorkosAuthenticator (Phase B follow-up, needs @workos-inc/node). When
  // it lands, construct it from `config.workos` and prefer it whenever those
  // credentials are present, falling back to the stub only under the dev flag.
  const devAuth =
    process.env.RELAY_CP_DEV_STUB_AUTH === '1' || process.env.NODE_ENV === 'development';
  if (!devAuth) {
    throw new Error(
      'No authenticator configured: WorkOS wiring is a Phase B follow-up. Set RELAY_CP_DEV_STUB_AUTH=1 to run with the dev stub authenticator.',
    );
  }
  const authenticator: Authenticator = new StubAuthenticator();
  logger.info('using StubAuthenticator (dev) — WorkOS wiring is a Phase B follow-up');

  const app = createApi({ provisioning, authenticator });

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info(`control plane listening on :${info.port}`);
    logger.info(`relay admin target: ${config.relayAdminUrl}`);
    logger.info(`gateway zone: ${config.relayZone}`);
  });

  const shutdown = (signal: string): void => {
    logger.info(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
