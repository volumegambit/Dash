import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConsoleLogger } from '@dash/logging';
import { serve } from '@hono/node-server';
import { WorkOS } from '@workos-inc/node';
import { createApi } from './api.js';
import { WorkosAuthenticator, createWorkosVerifier } from './auth-workos.js';
import { type Authenticator, StubAuthenticator } from './auth.js';
import { loadConfig } from './config.js';
import { DialTokenSigner } from './dial-token-signer.js';
import { GatewayAssertionAuthenticator } from './gateway-assertion-auth.js';
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

  // Authenticator selection. WorkOS is the production identity provider: when its
  // credentials are configured, every request is authenticated by verifying a
  // WorkOS access token against the JWKS. The dev StubAuthenticator (trusts an
  // `x-test-account` header) is available only behind an explicit opt-in flag so
  // it can never be enabled in production by accident.
  let authenticator: Authenticator;
  const devAuth =
    process.env.RELAY_CP_DEV_STUB_AUTH === '1' || process.env.NODE_ENV === 'development';
  if (config.workos) {
    const workos = new WorkOS(config.workos.apiKey);
    authenticator = new WorkosAuthenticator(createWorkosVerifier(workos, config.workos.clientId));
    logger.info('using WorkosAuthenticator (WorkOS identity)');
  } else if (devAuth) {
    authenticator = new StubAuthenticator();
    logger.info('using StubAuthenticator (dev) — set RELAY_CP_WORKOS_* for production auth');
  } else {
    throw new Error(
      'No authenticator configured: set WorkOS credentials (RELAY_CP_WORKOS_API_KEY + RELAY_CP_WORKOS_CLIENT_ID) or RELAY_CP_DEV_STUB_AUTH=1 for the dev stub.',
    );
  }

  const gatewayAssertionAuth = new GatewayAssertionAuthenticator({
    store,
    signer,
    verifyPublicKey: (b64) =>
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64 }, format: 'jwk' }),
  });

  const app = createApi({ provisioning, authenticator, gatewayAssertionAuth });

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
