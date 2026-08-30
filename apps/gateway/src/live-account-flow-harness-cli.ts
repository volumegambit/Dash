import { createControlPlaneClient } from './control-plane-client.js';
import { createDialTokenManager } from './dial-token-manager.js';
import { loadOrCreateGatewayIdentity } from './gateway-identity.js';
import { startMobileTestHarness } from './mobile-test-harness.js';
import { startRelayClient } from './relay-client.js';

/**
 * Executable entrypoint that boots the SAME deterministic scripted gateway
 * `mobile-test-harness.ts` already uses for the direct-LAN live suite, then
 * ALSO enrolls it with a (locally running, dev-stub-auth) control plane and
 * dials it into a (locally running) relay — the two pieces the direct-LAN
 * harness never needed. This is Task 9's Node-side condensation of the
 * `.claude/skills/relay-e2e` rig: same holder-of-key dial flow production
 * gateways use (`gateway-identity.ts` + `control-plane-client.ts` +
 * `dial-token-manager.ts` + `relay-client.ts`), pointed at throwaway local
 * relay/CP processes the orchestrating script (`ios/scripts/
 * run-live-account-flow-test.mjs`) starts alongside this one.
 *
 * Usage:
 *   node --import tsx apps/gateway/src/live-account-flow-harness-cli.ts \
 *     --cp-url http://127.0.0.1:9400 --relay-url ws://127.0.0.1:8444 \
 *     --gateway-id 127 --account acct-live-ios-test
 */

interface Args {
  cpUrl: string;
  relayUrl: string;
  gatewayId: string;
  account: string;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (typeof value !== 'string') throw new Error(`Missing value for ${flag}`);
    values.set(flag, value);
  }
  const cpUrl = values.get('--cp-url');
  const relayUrl = values.get('--relay-url');
  const gatewayId = values.get('--gateway-id');
  const account = values.get('--account');
  if (!cpUrl || !relayUrl || !gatewayId || !account) {
    throw new Error(
      'Usage: live-account-flow-harness-cli --cp-url <url> --relay-url <url> ' +
        '--gateway-id <id> --account <accountId>',
    );
  }
  return { cpUrl, relayUrl, gatewayId, account };
}

interface CreatedGatewayResponse {
  gatewayId: string;
  subdomain: string;
  dialToken: string;
}

async function registerGateway(
  cpUrl: string,
  account: string,
  subdomain: string,
  publicKey: string,
): Promise<CreatedGatewayResponse> {
  const res = await fetch(`${cpUrl}/v1/gateways`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-account': account },
    body: JSON.stringify({ subdomain, publicKey }),
  });
  if (!res.ok) {
    throw new Error(`control plane gateway registration failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as CreatedGatewayResponse;
}

async function registerWebChatToken(
  cpUrl: string,
  account: string,
  gatewayId: string,
  chatToken: string,
): Promise<void> {
  const res = await fetch(`${cpUrl}/v1/gateways/${encodeURIComponent(gatewayId)}/web-chat-token`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-test-account': account },
    body: JSON.stringify({ chatToken }),
  });
  if (!res.ok) {
    throw new Error(`control plane web-chat-token registration failed: ${res.status}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const harness = await startMobileTestHarness({ scenario: 'stream' });
  const managementPort = Number(new URL(harness.managementBaseUrl).port);
  const channelPort = Number(new URL(harness.chatWebSocketUrl).port);

  const identity = await loadOrCreateGatewayIdentity(harness.dataDir);
  const created = await registerGateway(
    args.cpUrl,
    args.account,
    args.gatewayId,
    identity.publicKeyB64,
  );
  await registerWebChatToken(args.cpUrl, args.account, created.gatewayId, harness.chatToken);

  const cpClient = createControlPlaneClient({
    controlPlaneUrl: args.cpUrl,
    gatewayId: created.gatewayId,
    identity,
  });
  const logger = {
    info: (m: string) => console.error(`[live-account-flow-harness] ${m}`),
    warn: (m: string) => console.error(`[live-account-flow-harness] ${m}`),
    error: (m: string) => console.error(`[live-account-flow-harness] ${m}`),
  };
  // biome-ignore lint/style/useConst: forward-referenced by the redial/onAuthFailure closures below, before this is assigned.
  let relayClient: ReturnType<typeof startRelayClient> | undefined;
  const dialTokenManager = createDialTokenManager({
    cpClient,
    dataDir: harness.dataDir,
    seedToken: created.dialToken,
    redial: () => relayClient?.redialNow(),
    logger,
  });
  await dialTokenManager.start();
  relayClient = startRelayClient({
    relayUrl: args.relayUrl,
    relayToken: created.dialToken,
    getRelayToken: () => dialTokenManager.getToken(),
    signProof: () => identity.signProof(created.gatewayId),
    onAuthFailure: () => dialTokenManager.onAuthFailure(),
    gatewayId: created.gatewayId,
    managementPort,
    channelPort,
    logger,
  });

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.error(`[live-account-flow-harness] received ${signal}; stopping`);
    relayClient?.stop();
    dialTokenManager.stop();
    void harness
      .stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(
          '[live-account-flow-harness] shutdown failed:',
          error instanceof Error ? error.message : String(error),
        );
        process.exit(1);
      });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  console.error(
    `[live-account-flow-harness] ready (gateway "${created.gatewayId}" dialing ${args.relayUrl})`,
  );
  process.stdout.write(
    `${JSON.stringify({
      type: 'ready',
      gatewayId: created.gatewayId,
      subdomain: created.subdomain,
      agentId: harness.agentId,
      dataDir: harness.dataDir,
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  console.error(
    '[live-account-flow-harness] failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
