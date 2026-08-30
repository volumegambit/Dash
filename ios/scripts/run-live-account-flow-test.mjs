import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertSinglePassedTest } from './run-live-gateway-tests.mjs';

// Task 9's live integration rig: a sign-in-shaped mint against a REAL control
// plane + relay + gateway, then one chat round-trip, driven end to end through
// the actual iOS networking stack (`ControlPlaneClient` -> `AccountConnectFeature`
// -> `PairingVerifier`/`PairingProfileInstaller` -> `ChatConnection`). This is a
// condensation of the proven `.claude/skills/relay-e2e` rig (local-only, never
// committed) into a self-contained, committed script:
//
//   relay (plaintext, hosted mode) <- CP (dev-stub auth) <- gateway (scripted
//   backend, dials in with its own Ed25519 holder-of-key identity) <- TLS
//   terminator on :443 (the ONE port `PairingPayload.validated()` hardcodes for
//   v2/relay pairings) <- iOS Simulator.
//
// Two problems the manual Android rig solved with real (Tailscale-poisoned on
// this host) DNS and a high port are sidestepped entirely here:
//   1. No hostname needed: the relay routes by the FIRST LABEL of the Host
//      header (`gatewayIdFromHost`, apps/relay/src/relay-server.ts), so a
//      gateway registered under subdomain LABEL "127" + relay-zone "0.0.1"
//      gets the CP-returned `subdomain` "127.0.0.1" -- a literal dotted-quad
//      the app connects to directly, no DNS lookup at all.
//   2. No pinned-cert plumbing: v2/relay `ConnectionProfile`s carry no TLS
//      pin (`ConnectionEndpoint.swift` `case 2:` sets `tlsCertificateSha256:
//      nil`), so `GatewayURLSessionFactory` falls back to ordinary system
//      trust. `xcrun simctl keychain <udid> add-root-cert` (no sudo) makes
//      the simulator trust our throwaway self-signed CA for this one test.
//
// Binding :443 without root is NOT possible on macOS (verified: EACCES for any
// non-root process); this script fails fast with a clear message if it can't,
// rather than burning a 10-minute xcodebuild cycle first.

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, '../..');
const DEVICE_NAME = 'iPhone 17 Pro';
const XCODEBUILD_TIMEOUT_MS = 10 * 60_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const READINESS_TIMEOUT_MS = 30_000;
const TEST_TARGET = 'DashIntegrationTests/LiveAccountFlowTests/testAccountSignInMintAndChat';

const RELAY_PORT = 18544;
const CP_PORT = 18400;
const RELAY_ADMIN_SECRET = 'live-account-flow-admin-secret';
const GATEWAY_LABEL = '127';
const RELAY_ZONE = '0.0.1';
const ACCOUNT_ID = 'acct-live-account-flow-test';
const TERMINATOR_PORT = 443;

const activeChildren = new Set();
let interruptExitCode = null;
let interruptCount = 0;

function delay(ms) {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    t.unref?.();
  });
}

function trackedSpawn(command, args, options) {
  const child = spawn(command, args, options);
  activeChildren.add(child);
  const untrack = () => activeChildren.delete(child);
  child.once('error', untrack);
  child.once('exit', untrack);
  return child;
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((res) => child.once('exit', () => res()));
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child);
  child.kill('SIGTERM');
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(SHUTDOWN_TIMEOUT_MS).then(() => false),
  ]);
  if (graceful) return;
  child.kill('SIGKILL');
  await Promise.race([exited, delay(SHUTDOWN_TIMEOUT_MS)]);
}

function handleInterrupt(signal) {
  interruptExitCode ??= signal === 'SIGINT' ? 130 : 143;
  interruptCount += 1;
  const childSignal = interruptCount > 1 ? 'SIGKILL' : 'SIGTERM';
  for (const child of activeChildren) child.kill(childSignal);
}

function runCommand(command, args, options = {}) {
  const { captureStdout = false, env, quiet = false, timeoutMs, label = command } = options;
  return new Promise((resolveCommand, rejectCommand) => {
    const child = trackedSpawn(command, args, {
      cwd: ROOT_DIR,
      env,
      stdio: [
        'ignore',
        captureStdout ? 'pipe' : quiet ? 'ignore' : 'inherit',
        quiet ? 'ignore' : 'inherit',
      ],
    });
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), SHUTDOWN_TIMEOUT_MS).unref?.();
        }, timeoutMs)
      : null;
    timer?.unref?.();
    child.once('error', (error) => {
      if (timer) clearTimeout(timer);
      rejectCommand(error);
    });
    child.once('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        resolveCommand({ code: 124, signal, stdout, timedOut: true });
        return;
      }
      resolveCommand({ code: code ?? 1, signal, stdout, timedOut: false });
    });
  }).then((result) => {
    if (result.timedOut) process.stderr.write(`[live-account-flow] ${label} timed out\n`);
    return result;
  });
}

function destinationUDID(destination) {
  if (!destination.startsWith('id=') || destination.length <= 3) {
    throw new Error('Simulator destination is not an exact UDID');
  }
  return destination.slice(3);
}

async function simulatorLaunchd(udid, action, name, value) {
  const args = ['simctl', 'spawn', udid, 'launchctl', action, name];
  if (value !== undefined) args.push(value);
  const result = await runCommand('xcrun', args, {
    quiet: true,
    timeoutMs: 30_000,
    label: `simulator environment ${action}`,
  });
  if (result.code !== 0) {
    throw new Error(`Could not ${action} the scoped simulator test environment`);
  }
}

async function clearSimulatorEnvironment(udid, names) {
  let failure;
  for (const name of names) {
    try {
      await simulatorLaunchd(udid, 'unsetenv', name);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

async function withSimulatorEnvironment(destination, values, operation) {
  const udid = destinationUDID(destination);
  const names = Object.keys(values);
  await clearSimulatorEnvironment(udid, names);
  try {
    for (const [name, value] of Object.entries(values)) {
      await simulatorLaunchd(udid, 'setenv', name, value);
    }
    return await operation();
  } finally {
    await clearSimulatorEnvironment(udid, names);
  }
}

/**
 * Find an available `DEVICE_NAME` simulator across whatever runtimes this
 * Xcode install has (unlike `run-live-gateway-tests.mjs`, which pins a
 * specific runtime + requires `ensure-simulators.sh`'s Xcode 16.3 preflight —
 * this rig targets whatever's already on the host, matching the destination
 * given in the plan brief: `iPhone 17 Pro,OS=26.5`). Prefers an
 * already-booted match to avoid an unnecessary boot cycle.
 */
async function resolveDestination() {
  const listed = await runCommand('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
    captureStdout: true,
    timeoutMs: 30_000,
    label: 'simulator inventory',
  });
  if (listed.code !== 0) return { code: listed.code, destination: null };
  let simctl;
  try {
    simctl = JSON.parse(listed.stdout);
  } catch {
    throw new Error('simctl returned invalid device JSON');
  }
  const candidates = Object.values(simctl?.devices ?? {})
    .flat()
    .filter((device) => device?.isAvailable !== false && device?.name === DEVICE_NAME);
  const chosen = candidates.find((d) => d.state === 'Booted') ?? candidates[0];
  if (!chosen?.udid) throw new Error(`No available "${DEVICE_NAME}" simulator exists`);
  const destination = `id=${chosen.udid}`;
  const booted = await runCommand('xcrun', ['simctl', 'bootstatus', chosen.udid, '-b'], {
    timeoutMs: 5 * 60_000,
    label: 'simulator boot',
  });
  if (booted.code !== 0) return { code: booted.code, destination: null };
  return { code: 0, destination };
}

/** Ed25519 dial-token keypair + a self-signed TLS cert (SAN IP 127.0.0.1). */
async function generateCryptoMaterial(workdir) {
  const dialPriv = join(workdir, 'cp-dial-priv.pem');
  const dialPub = join(workdir, 'cp-dial-pub.pem');
  const tlsKey = join(workdir, 'tls-key.pem');
  const caCert = join(workdir, 'ca.pem');
  const sanConf = join(workdir, 'san.cnf');

  let result = await runCommand('openssl', ['genpkey', '-algorithm', 'ed25519', '-out', dialPriv], {
    quiet: true,
    timeoutMs: 15_000,
    label: 'openssl genpkey',
  });
  if (result.code !== 0) throw new Error('Failed to generate the dial-token Ed25519 keypair');
  result = await runCommand('openssl', ['pkey', '-in', dialPriv, '-pubout', '-out', dialPub], {
    quiet: true,
    timeoutMs: 15_000,
    label: 'openssl pkey',
  });
  if (result.code !== 0) throw new Error('Failed to derive the dial-token public key');

  await writeFile(
    sanConf,
    [
      '[req]',
      'distinguished_name = req_distinguished_name',
      'x509_extensions = v3_req',
      'prompt = no',
      '[req_distinguished_name]',
      'CN = dash-live-account-flow-test',
      '[v3_req]',
      'basicConstraints = CA:FALSE',
      'keyUsage = digitalSignature, keyEncipherment',
      'extendedKeyUsage = serverAuth',
      'subjectAltName = @alt_names',
      '[alt_names]',
      'IP.1 = 127.0.0.1',
      '',
    ].join('\n'),
  );
  result = await runCommand(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-keyout',
      tlsKey,
      '-out',
      caCert,
      '-config',
      sanConf,
    ],
    { quiet: true, timeoutMs: 30_000, label: 'openssl req' },
  );
  if (result.code !== 0) throw new Error('Failed to generate the self-signed TLS certificate');

  return { dialPriv, dialPub, tlsKey, caCert };
}

function waitForTcpOpen(port, host = '127.0.0.1', timeoutMs = READINESS_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveReady, rejectReady) => {
    const attempt = () => {
      const socket = net.connect(port, host);
      socket.once('connect', () => {
        socket.destroy();
        resolveReady();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          rejectReady(new Error(`Timed out waiting for ${host}:${port} to accept connections`));
          return;
        }
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

async function waitForHttpHealth(url, timeoutMs = READINESS_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // control plane not up yet
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${url}`);
    await delay(200);
  }
}

/**
 * Mint a throwaway pairing credential directly against the CP (no shim — we
 * speak its native `x-test-account` stub header ourselves), purely to drive
 * the tunnel-health probe below. The relay gates EVERY phone request on a
 * valid `x-dash-relay-credential` (apps/relay/src/relay-server.ts
 * `handlePhoneHttp`), even `/mobile/v1/health`, independently of whether the
 * gateway has actually dialed in — so an unauthenticated probe would always
 * read 401 and never prove the tunnel is live.
 */
async function mintThrowawayCredential(cpUrl, gatewayId) {
  const res = await fetch(`${cpUrl}/v1/gateways/${gatewayId}/pairings/pairing-id-v1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-account': ACCOUNT_ID },
    body: JSON.stringify({ deviceLabel: 'tunnel-health-probe', clientKind: 'mobile' }),
  });
  if (!res.ok) throw new Error(`Failed to mint a throwaway pairing credential: ${res.status}`);
  const body = await res.json();
  if (typeof body.credential !== 'string' || body.credential.length === 0) {
    throw new Error('Control plane did not return a pairing credential');
  }
  return body.credential;
}

/**
 * Poll the relay->gateway tunnel through the TLS terminator until it answers.
 * Verifies against our own freshly-generated CA (never disables verification —
 * the terminator's cert chains to `caCert`, and we connect to the literal IP
 * its SAN covers, so ordinary hostname+chain validation succeeds).
 */
async function waitForTunnelHealth(caCert, credential, timeoutMs = READINESS_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise((resolveCheck) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port: TERMINATOR_PORT,
          path: '/mobile/v1/health',
          method: 'GET',
          ca: caCert,
          headers: { host: '127.0.0.1', 'x-dash-relay-credential': credential },
        },
        (res) => {
          res.resume();
          resolveCheck(res.statusCode === 200);
        },
      );
      req.on('error', () => resolveCheck(false));
      req.end();
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the relay tunnel to come up');
    await delay(200);
  }
}

/**
 * Translate `Authorization: Bearer X` into the CP's dev-stub header
 * (`x-test-account: X`). The real `ControlPlaneClient` (Swift) only ever sends
 * `Authorization`; `StubAuthenticator` (apps/relay-control-plane/src/auth.ts)
 * only ever reads `x-test-account` and has no CLI/env override for the header
 * name. This ~15-line shim is the seam the plan brief calls for rather than
 * changing production auth code for a test harness.
 */
function startAuthShim(cpPort) {
  const server = createHttpServer((req, res) => {
    const headers = { ...req.headers };
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (bearer) headers['x-test-account'] = bearer[1];
    // biome-ignore lint/performance/noDelete: an undefined assignment throws (ERR_HTTP_INVALID_HEADER_VALUE) -- Node's http client special-cases "host".
    delete headers.host;
    const upstream = httpRequest(
      { host: '127.0.0.1', port: cpPort, method: req.method, path: req.url, headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`auth shim upstream error: ${err.message}`);
    });
    req.pipe(upstream);
  });
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen(server);
    });
  });
}

/** TLS-terminate :443 -> plaintext relay. Condensed from the proven manual rig. */
function startTlsTerminator(tlsKey, tlsCert) {
  const server = createHttpsServer({ key: tlsKey, cert: tlsCert }, (clientReq, clientRes) => {
    const proxyReq = httpRequest(
      {
        host: '127.0.0.1',
        port: RELAY_PORT,
        method: clientReq.method,
        path: clientReq.url,
        headers: clientReq.headers,
      },
      (proxyRes) => {
        clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(clientRes);
      },
    );
    proxyReq.on('error', (err) => {
      if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'text/plain' });
      clientRes.end(`relay proxy error: ${err.message}`);
    });
    clientReq.pipe(proxyReq);
  });
  server.on('upgrade', (req, clientSocket, head) => {
    const upstream = net.connect(RELAY_PORT, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      lines.push('\r\n');
      upstream.write(lines.join('\r\n'));
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const onErr = () => {
      clientSocket.destroy();
      upstream.destroy();
    };
    upstream.on('error', onErr);
    clientSocket.on('error', onErr);
  });
  server.on('tlsClientError', () => {});
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(TERMINATOR_PORT, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen(server);
    });
  });
}

function closeServer(server) {
  return new Promise((res) => server.close(() => res()));
}

/** Spawn the gateway+relay-dial-in harness and await its readiness JSON line. */
function startGatewayHarness(cpUrl, relayUrl) {
  const child = trackedSpawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'apps/gateway/src/live-account-flow-harness-cli.ts',
      '--cp-url',
      cpUrl,
      '--relay-url',
      relayUrl,
      '--gateway-id',
      GATEWAY_LABEL,
      '--account',
      ACCOUNT_ID,
    ],
    { cwd: ROOT_DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });

  const readiness = new Promise((resolveReadiness, rejectReadiness) => {
    const timer = setTimeout(() => {
      rejectReadiness(new Error('Timed out waiting for the gateway harness readiness'));
    }, READINESS_TIMEOUT_MS);
    timer.unref?.();
    let buffer = '';
    let seen = false;
    const fail = (error) => {
      if (seen) return;
      clearTimeout(timer);
      rejectReadiness(error);
    };
    child.once('error', fail);
    child.once('exit', (code, signal) => {
      if (!seen) fail(new Error(`Gateway harness exited before readiness (${code ?? signal})`));
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines.filter((l) => l.trim().length > 0)) {
        if (seen) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.type !== 'ready') throw new Error('unexpected readiness record');
          seen = true;
          clearTimeout(timer);
          resolveReadiness(parsed);
        } catch (error) {
          fail(error);
        }
      }
    });
  });

  return { child, readiness, diagnostics: () => stderr };
}

async function main() {
  const { code, destination } = await resolveDestination();
  if (code !== 0 || !destination) {
    process.exitCode = code || 1;
    return;
  }
  const udid = destinationUDID(destination);
  const workdir = await mkdtemp(join(tmpdir(), 'dash-live-account-flow-'));

  let relayChild;
  let cpChild;
  let gatewayHarness;
  let shimServer;
  let terminatorServer;
  let outcome = 1;

  try {
    const crypto = await generateCryptoMaterial(workdir);

    relayChild = trackedSpawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/relay/src/main.ts',
        '--host',
        '127.0.0.1',
        '--port',
        String(RELAY_PORT),
        '--dial-token-public-key',
        crypto.dialPub,
        '--store-path',
        join(workdir, 'relay-creds.db'),
        '--admin-secret',
        RELAY_ADMIN_SECRET,
      ],
      { cwd: ROOT_DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    relayChild.stdout?.on('data', () => {});
    relayChild.stderr?.on('data', () => {});

    cpChild = trackedSpawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/relay-control-plane/src/main.ts',
        '--port',
        String(CP_PORT),
        '--db-path',
        join(workdir, 'cp.db'),
        '--relay-admin-url',
        `http://127.0.0.1:${RELAY_PORT}`,
        '--relay-admin-secret',
        RELAY_ADMIN_SECRET,
        '--relay-zone',
        RELAY_ZONE,
        '--dial-token-private-key',
        crypto.dialPriv,
      ],
      {
        cwd: ROOT_DIR,
        env: { ...process.env, RELAY_CP_DEV_STUB_AUTH: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    cpChild.stdout?.on('data', () => {});
    cpChild.stderr?.on('data', () => {});

    await waitForTcpOpen(RELAY_PORT);
    await waitForHttpHealth(`http://127.0.0.1:${CP_PORT}/health`);

    gatewayHarness = startGatewayHarness(
      `http://127.0.0.1:${CP_PORT}`,
      `ws://127.0.0.1:${RELAY_PORT}`,
    );
    const readiness = await gatewayHarness.readiness;

    shimServer = await startAuthShim(CP_PORT);
    const shimPort = shimServer.address().port;

    const caCertBuffer = await readFile(crypto.caCert);
    try {
      terminatorServer = await startTlsTerminator(await readFile(crypto.tlsKey), caCertBuffer);
    } catch (error) {
      if (error?.code === 'EACCES') {
        process.stderr.write(
          '[live-account-flow] Cannot bind TCP :443 without elevated privileges. ' +
            "`AccountConnectFeature`'s v2/relay pairing hardcodes port 443 " +
            '(ios/Dash/Core/Networking/ConnectionEndpoint.swift `validated()` case 2) with no ' +
            'override, so this live test requires a process that can bind it (root, or an ' +
            'equivalent CAP_NET_BIND_SERVICE grant). Re-run this script with sufficient ' +
            'privileges to exercise the real sign-in -> relay -> chat path.\n',
        );
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    const probeCredential = await mintThrowawayCredential(
      `http://127.0.0.1:${CP_PORT}`,
      readiness.gatewayId,
    );
    await waitForTunnelHealth(caCertBuffer, probeCredential);
    await runCommand('xcrun', ['simctl', 'keychain', udid, 'add-root-cert', crypto.caCert], {
      timeoutMs: 30_000,
      label: 'simctl add-root-cert',
    });

    const testEnvironment = {
      DASH_TEST_ACCOUNT_CONTROL_PLANE_URL: `http://127.0.0.1:${shimPort}`,
      DASH_TEST_ACCOUNT_BEARER: ACCOUNT_ID,
      DASH_TEST_ACCOUNT_GATEWAY_ID: readiness.gatewayId,
      DASH_TEST_ACCOUNT_AGENT_ID: readiness.agentId,
    };

    const bundlePath = 'ios/LiveAccountFlow.xcresult';
    await rm(resolve(ROOT_DIR, bundlePath), { recursive: true, force: true });
    const result = await withSimulatorEnvironment(destination, testEnvironment, () =>
      runCommand(
        'xcodebuild',
        [
          '-project',
          'ios/Dash.xcodeproj',
          '-scheme',
          'DashIntegration',
          '-destination',
          destination,
          '-collect-test-diagnostics',
          'never',
          '-resultBundlePath',
          bundlePath,
          `-only-testing:${TEST_TARGET}`,
          'test',
          'CODE_SIGNING_ALLOWED=NO',
        ],
        {
          env: { ...process.env, ...testEnvironment },
          timeoutMs: XCODEBUILD_TIMEOUT_MS,
          label: TEST_TARGET,
        },
      ),
    );

    outcome = result.code;
    if (outcome === 0) {
      const summaryResult = await runCommand(
        'xcrun',
        ['xcresulttool', 'get', 'test-results', 'summary', '--path', bundlePath],
        { captureStdout: true, timeoutMs: 30_000, label: `${TEST_TARGET} result verification` },
      );
      try {
        if (summaryResult.code !== 0) throw new Error('xcresulttool could not read the result');
        assertSinglePassedTest(JSON.parse(summaryResult.stdout));
      } catch {
        process.stderr.write(
          `[live-account-flow] ${TEST_TARGET} did not execute exactly one passing test\n`,
        );
        outcome = 1;
      }
    }
    if (outcome !== 0) {
      process.stderr.write(
        `[live-account-flow] gateway harness diagnostics (redacted length): ${gatewayHarness.diagnostics().length}\n`,
      );
    } else {
      await rm(resolve(ROOT_DIR, bundlePath), { recursive: true, force: true });
    }
  } finally {
    if (terminatorServer) await closeServer(terminatorServer);
    if (shimServer) await closeServer(shimServer);
    await terminate(gatewayHarness?.child);
    await terminate(cpChild);
    await terminate(relayChild);
    await rm(workdir, { recursive: true, force: true });
  }

  process.exitCode = interruptExitCode ?? outcome;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const onInterrupt = () => handleInterrupt('SIGINT');
  const onTerminate = () => handleInterrupt('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `[live-account-flow] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = interruptExitCode ?? 1;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}
