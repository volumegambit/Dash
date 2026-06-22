// @vitest-environment node
//
// Phase C integration test (Task 9): the hosted remote-access slice end to end,
// driven at the **main-process level with no Electron UI**. It wires the *real*
// collaborators MC composes at runtime — a real control plane (createApi +
// ProvisioningService + SqliteStore + DialTokenSigner) whose admin target is a
// real relay (createRelayServer), the real `ControlPlaneSession` loopback
// sign-in (with WorkOS behind an injected `exchangeCode` seam, no browser), the
// real `createControlPlaneClient`, the real keychain store, and the real
// `buildPairingInfo` that `pairing:getInfo` calls — and proves the whole path:
//
//   sign in (fake exchange)        → session token persisted in the keychain
//   enroll (real CP + real relay)  → issued gateway cached; gateway dials in
//   pairing:getInfo                → a v2 QR whose relayCredential the relay validates
//   devices:revoke                 → that same credential is invalidated at the edge
//
// The v2 QR wire shape is the fixed `{v:2,host,secure,mgmtToken,chatToken,
// relayCredential}` the Android app depends on — asserted here so a drift fails
// loudly. The live WorkOS browser round-trip + Electron shell.openExternal are
// manual MC QA, not CI; every other seam is real.

import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DurableCredentialStore,
  type Frame,
  type RelayServer,
  createRelayServer,
  decodeFrame,
  encodeFrame,
  hostedRelayAuth,
} from '@dash/relay';
import {
  type Authenticator,
  DialTokenSigner,
  ProvisioningService,
  RelayAdminClient,
  SqliteStore,
  createApi,
} from '@dash/relay-control-plane';
import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createControlPlaneClient } from '../../../../packages/mc/src/runtime/control-plane-client.js';
import {
  type ControlPlaneSessionTokenStore,
  createControlPlaneSession,
} from '../../../../packages/mc/src/runtime/control-plane-session.js';
import { InMemoryKeychainStore } from '../../../../packages/mc/src/security/keychain-store.js';
import { buildPairingInfo } from './pairing.js';

// The control plane signs dial tokens with this private key; the real relay
// verifies them with the matching public key.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');

/** Trusts the bearer token verbatim as the accountId (the session sends one). */
class BearerAccountAuthenticator implements Authenticator {
  async authenticate(
    headers: Record<string, string | undefined>,
  ): Promise<{ accountId: string } | null> {
    const auth = headers.authorization;
    if (!auth?.startsWith('Bearer ')) return null;
    const token = auth.slice('Bearer '.length).trim();
    return token ? { accountId: token } : null;
  }
}

let relayServer: RelayServer;
let relayStore: DurableCredentialStore;
let relayPort: number;
let cpServer: ReturnType<typeof serve>;
let cpBaseUrl: string;

beforeEach(async () => {
  relayStore = new DurableCredentialStore(':memory:');
  relayServer = createRelayServer(hostedRelayAuth({ publicKey, store: relayStore }), {
    admin: { secret: 'master', store: relayStore },
  });
  await new Promise<void>((r) => relayServer.httpServer.listen(0, '127.0.0.1', () => r()));
  relayPort = (relayServer.httpServer.address() as AddressInfo).port;

  const store = new SqliteStore(':memory:');
  const signer = new DialTokenSigner(privateKey, 3600, () => Math.floor(Date.now() / 1000));
  const relay = new RelayAdminClient(`http://127.0.0.1:${relayPort}`, 'master');
  const provisioning = new ProvisioningService({
    store,
    signer,
    relay,
    relayZone: 'relay.example.com',
  });
  const app = createApi({ provisioning, authenticator: new BearerAccountAuthenticator() });

  cpServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((r) => {
    (cpServer as http.Server).once('listening', () => r());
    if ((cpServer as http.Server).listening) r();
  });
  const cpAddr = (cpServer as http.Server).address() as AddressInfo;
  cpBaseUrl = `http://127.0.0.1:${cpAddr.port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => (cpServer as http.Server).close(() => r()));
  await relayServer.close();
});

/** Dial in a fake gateway presenting the CP-signed dial token at /gw/:gatewayId. */
function connectGateway(gatewayId: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/gw/${gatewayId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Make the fake gateway answer every proxied request with 200 'ok'. */
function respondOk(gw: WebSocket): void {
  gw.on('message', (raw: Buffer) => {
    const f: Frame = decodeFrame(raw.toString());
    if (f.t === 'open') {
      gw.send(encodeFrame({ t: 'head', streamId: f.streamId, status: 200, headers: {} }));
      gw.send(
        encodeFrame({
          t: 'data',
          streamId: f.streamId,
          chunk: Buffer.from('ok').toString('base64'),
        }),
      );
      gw.send(encodeFrame({ t: 'end', streamId: f.streamId }));
    }
  });
}

/** A phone request to the relay edge, routed by Host subdomain + credential header. */
function phoneGet(
  gatewayId: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: relayPort,
        path: '/health',
        method: 'GET',
        headers: { host: `${gatewayId}.relay.local`, ...headers },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Keychain-backed token store for the session (Task 3 accessors). */
function keychainTokenStore(keychain: InMemoryKeychainStore): ControlPlaneSessionTokenStore {
  return {
    get: () => keychain.getControlPlaneToken(),
    set: (value) => keychain.setControlPlaneToken(value),
    clear: () => keychain.clearAllGatewayTokens(),
  };
}

/**
 * Drive the loopback sign-in to completion without a browser: instead of
 * opening a real browser, fetch the loopback callback URL the session would be
 * redirected back to. We capture the redirect_uri the session builds, append a
 * fake `code`, and GET it — exactly what the system browser would do.
 */
function driveLoopbackSignIn(keychain: InMemoryKeychainStore, accountToken: string) {
  return createControlPlaneSession({
    tokenStore: keychainTokenStore(keychain),
    // The auth URL embeds the loopback redirect_uri + CSRF state; echo both back.
    buildAuthUrl: (redirectUri, state) =>
      `https://workos.example/authorize?redirect_uri=${redirectUri}&state=${state}`,
    // "Open the browser": parse the redirect_uri + state out of the URL and GET
    // the callback with a fake authorization code — the browser's job, no UI.
    openBrowser: async (url) => {
      const u = new URL(url);
      const redirectUri = decodeURIComponent(u.searchParams.get('redirect_uri') ?? '');
      const state = u.searchParams.get('state') ?? '';
      const res = await fetch(`${redirectUri}?code=fake-auth-code&state=${state}`);
      // Drain so the loopback server's response completes.
      await res.text();
    },
    // WorkOS exchange seam: a real account would come back here. We mint the
    // bearer the StubAuthenticator-style CP trusts verbatim as the accountId.
    exchangeCode: async (code) => {
      expect(code).toBe('fake-auth-code');
      return { accessToken: accountToken, expiresAt: Date.now() + 3_600_000 };
    },
  });
}

describe('hosted remote-access slice (main-process integration)', () => {
  let keychain: InMemoryKeychainStore;

  beforeEach(() => {
    keychain = new InMemoryKeychainStore();
  });

  it('signs in, enrolls, pairs (v2 QR validated by the relay), and revokes', async () => {
    // 1. SIGN IN — loopback OAuth with a fake exchange; token lands in the keychain.
    const session = driveLoopbackSignIn(keychain, 'acct-int');
    expect(await keychain.getControlPlaneToken()).toBeNull();
    await session.signIn();
    expect(await session.getToken()).toBe('acct-int');
    expect(await keychain.getControlPlaneToken()).toBe('acct-int');

    // The client authenticates with the session's token, exactly as MC wires it.
    const client = createControlPlaneClient(cpBaseUrl, () => session.getToken());

    // 2. ENROLL — the supervisor's enroll path: createGateway() once, cache the
    // issued record in the keychain. Then the gateway dials its own subdomain.
    let issued = await keychain.getIssuedGateway();
    expect(issued).toBeNull();
    const provision = await client.createGateway();
    const prefix = `${provision.gatewayId}.`;
    const host = provision.subdomain.startsWith(prefix)
      ? provision.subdomain.slice(prefix.length)
      : provision.subdomain;
    await keychain.setIssuedGateway({
      gatewayId: provision.gatewayId,
      dialToken: provision.dialToken,
      host,
    });
    issued = await keychain.getIssuedGateway();
    if (!issued) throw new Error('expected an issued gateway after enroll');
    expect(issued.host).toBe('relay.example.com');

    const gw = await connectGateway(issued.gatewayId, issued.dialToken);
    respondOk(gw);
    await waitFor(() => relayServer.hasGateway(issued.gatewayId));

    // 3. pairing:getInfo — the real buildPairingInfo with the control-plane
    // provisioner (exactly the IPC handler's wiring). Asserts the fixed v2 shape.
    const info = await buildPairingInfo(
      {
        mgmtToken: 'm-tok',
        chatToken: 'c-tok',
        lan: { host: '192.168.1.50', mgmtPort: 9300, chatPort: 9200 },
        relay: { gatewayId: issued.gatewayId, host: issued.host },
      },
      async (gatewayId) => (await client.createPairing(gatewayId)).credential,
    );
    if (info.mode !== 'relay') throw new Error('expected relay-mode pairing info');
    expect(info).toEqual({
      mode: 'relay',
      host: `${issued.gatewayId}.relay.example.com`,
      secure: true,
      mgmtToken: 'm-tok',
      chatToken: 'c-tok',
      relayCredential: expect.any(String),
    });

    // The v2 QR payload the renderer encodes — the fixed Android wire shape.
    const qrPayload = {
      v: 2,
      host: info.host,
      secure: info.secure,
      mgmtToken: info.mgmtToken,
      chatToken: info.chatToken,
      relayCredential: info.relayCredential,
    };
    expect(qrPayload).toEqual({
      v: 2,
      host: `${issued.gatewayId}.relay.example.com`,
      secure: true,
      mgmtToken: 'm-tok',
      chatToken: 'c-tok',
      relayCredential: info.relayCredential,
    });

    // The relay validates the QR's relayCredential at its edge.
    const paired = await phoneGet(issued.gatewayId, {
      'x-dash-relay-credential': info.relayCredential,
    });
    expect(paired.status).toBe(200);
    expect(paired.body).toBe('ok');

    // 4. devices:revoke — find the device, revoke it, the relay rejects the cred.
    const gateways = await client.listGateways();
    const match = gateways.find((g) => g.gatewayId === issued.gatewayId);
    if (!match) throw new Error('enrolled gateway missing from listGateways');
    expect(match.devices).toHaveLength(1);
    const [device] = match.devices;

    await client.revokePairing(issued.gatewayId, device.id);

    const afterRevoke = await phoneGet(issued.gatewayId, {
      'x-dash-relay-credential': info.relayCredential,
    });
    expect(afterRevoke.status).toBe(401);

    gw.close();
  });

  it('refuses to mint a pairing credential when signed out', async () => {
    // Signed out → the session has no token → the CP answers 401 → createPairing
    // throws, and buildPairingInfo surfaces an actionable error.
    const client = createControlPlaneClient(cpBaseUrl, async () => null);
    await expect(
      buildPairingInfo(
        {
          mgmtToken: 'm-tok',
          chatToken: 'c-tok',
          lan: { host: '192.168.1.50', mgmtPort: 9300, chatPort: 9200 },
          relay: { gatewayId: 'gw-unknown', host: 'relay.example.com' },
        },
        async (gatewayId) => (await client.createPairing(gatewayId)).credential,
      ),
    ).rejects.toThrow(/Could not reach the relay.*401/);
  });
});
