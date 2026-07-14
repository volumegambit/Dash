import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, '../..');
const PINNED_RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-18-4';
const SCENARIOS = new Set(['stream', 'question', 'slow']);
export const gatewayHarnessReadinessTimeoutMs = 60_000;
const PREFLIGHT_TIMEOUT_MS = 20 * 60_000;
const XCODEBUILD_TIMEOUT_MS = 10 * 60_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const activeChildren = new Set();
let interruptExitCode = null;
let interruptCount = 0;

export const defaultScenarioMatrix = [
  {
    scenario: 'stream',
    target: 'DashIntegrationTests/HTTPAndSSEIntegrationTests/testHTTPAndSSE',
  },
  {
    scenario: 'stream',
    target: 'DashIntegrationTests/ChatResumeIntegrationTests/testDetachReplayResume',
  },
  {
    scenario: 'stream',
    target: 'DashIntegrationTests/CacheReconciliationIntegrationTests/testColdBootstrapAndRestart',
  },
  {
    scenario: 'question',
    target: 'DashIntegrationTests/ChatResumeIntegrationTests/testQuestionAnswer',
  },
  {
    scenario: 'slow',
    target: 'DashIntegrationTests/ChatResumeIntegrationTests/testExplicitCancel',
  },
  {
    scenario: 'slow',
    target:
      'DashIntegrationTests/CacheReconciliationIntegrationTests/' +
      'testBackgroundDetachForegroundReconciliation',
  },
];

export function selectIPhoneDestination(simctl) {
  const devices = simctl?.devices?.[PINNED_RUNTIME];
  if (!Array.isArray(devices)) return null;
  const phone = devices.find(
    (device) =>
      device?.isAvailable !== false &&
      typeof device?.name === 'string' &&
      device.name.startsWith('iPhone') &&
      typeof device?.udid === 'string' &&
      device.udid.length > 0,
  );
  return phone ? `id=${phone.udid}` : null;
}

export function parseRunnerArguments(argv) {
  if (argv.length === 0) return defaultScenarioMatrix.map((entry) => ({ ...entry }));
  if (argv.length !== 4) throw new Error(runnerUsage());

  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== '--scenario' && flag !== '--only-testing') throw new Error(runnerUsage());
    if (values.has(flag) || typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(runnerUsage());
    }
    values.set(flag, value.trim());
  }

  const scenario = values.get('--scenario');
  const target = values.get('--only-testing');
  if (!SCENARIOS.has(scenario) || !isIntegrationTarget(target)) throw new Error(runnerUsage());
  return [{ scenario, target }];
}

export function buildHarnessEnvironment(readiness, scenario) {
  if (!SCENARIOS.has(scenario)) throw new Error(`Unsupported live gateway scenario: ${scenario}`);
  const values = {
    DASH_TEST_MANAGEMENT_URL: readiness?.mobileBaseUrl,
    DASH_TEST_CHAT_URL: readiness?.mobileChatWebSocketUrl,
    DASH_TEST_TLS_CERTIFICATE_SHA256: readiness?.tlsCertificateSha256,
    // The phone's REST capability is intentionally the chat token. The gateway
    // accepts it only under `/mobile/v1`; the administrative bearer never
    // enters an iOS process or test environment.
    DASH_TEST_MANAGEMENT_TOKEN: readiness?.chatToken,
    DASH_TEST_CHAT_TOKEN: readiness?.chatToken,
    DASH_TEST_GATEWAY_ID: readiness?.gatewayId,
    DASH_TEST_AGENT_ID: readiness?.agentId,
    DASH_TEST_SCENARIO: scenario,
  };
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Harness readiness is missing ${name}`);
    }
  }
  return values;
}

export function assertSinglePassedTest(summary) {
  if (
    summary?.result !== 'Passed' ||
    summary?.passedTests !== 1 ||
    summary?.failedTests !== 0 ||
    summary?.skippedTests !== 0
  ) {
    throw new Error('Live gateway result must contain exactly one passed test and no other tests');
  }
}

function runnerUsage() {
  return (
    'Usage: node ios/scripts/run-live-gateway-tests.mjs ' +
    '[--scenario stream|question|slow --only-testing DashIntegrationTests/Suite/test]'
  );
}

function isIntegrationTarget(value) {
  return (
    typeof value === 'string' && /^DashIntegrationTests\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+$/.test(value)
  );
}

function childEnvironment(extra) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name, value]) => {
      return !name.startsWith('DASH_TEST_') && value !== undefined;
    }),
  );
  return { ...environment, ...extra };
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
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

function handleInterrupt(signal) {
  interruptExitCode ??= signal === 'SIGINT' ? 130 : 143;
  interruptCount += 1;
  const childSignal = interruptCount > 1 ? 'SIGKILL' : 'SIGTERM';
  for (const child of activeChildren) child.kill(childSignal);
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

function delay(milliseconds) {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    timer.unref?.();
  });
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
      if (stdout.length > 4 * 1024 * 1024) {
        child.kill('SIGTERM');
      }
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
    if (result.timedOut) process.stderr.write(`[live-ios] ${label} timed out\n`);
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

function parseReadinessLine(line) {
  let readiness;
  try {
    readiness = JSON.parse(line);
  } catch {
    throw new Error('Gateway harness emitted invalid readiness JSON');
  }
  if (readiness?.type !== 'ready') {
    throw new Error('Gateway harness emitted an unexpected readiness record');
  }
  buildHarnessEnvironment(readiness, 'stream');
  return readiness;
}

function startHarness(scenario) {
  const child = trackedSpawn(
    process.execPath,
    ['--import', 'tsx', 'apps/gateway/src/mobile-test-harness-cli.ts', '--scenario', scenario],
    {
      cwd: ROOT_DIR,
      env: childEnvironment({}),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  let buffer = '';
  let readinessSeen = false;
  let unexpectedStdout = false;
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });

  const readiness = new Promise((resolveReadiness, rejectReadiness) => {
    const timer = setTimeout(() => {
      rejectReadiness(new Error('Timed out waiting for gateway harness readiness'));
    }, gatewayHarnessReadinessTimeoutMs);
    timer.unref?.();
    const fail = (error) => {
      clearTimeout(timer);
      rejectReadiness(error);
    };
    child.once('error', fail);
    child.once('exit', (code, signal) => {
      if (!readinessSeen) {
        fail(
          new Error(
            `Gateway harness exited before readiness (${code ?? String(signal ?? 'unknown')})`,
          ),
        );
      }
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 65_536) {
        fail(new Error('Gateway harness readiness exceeded its size limit'));
        return;
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines.filter((value) => value.trim().length > 0)) {
        if (readinessSeen) {
          unexpectedStdout = true;
          continue;
        }
        try {
          const parsed = parseReadinessLine(line);
          readinessSeen = true;
          clearTimeout(timer);
          resolveReadiness(parsed);
        } catch (error) {
          fail(error);
        }
      }
    });
  });

  return {
    child,
    readiness,
    diagnostics() {
      return { stderr, unexpectedStdout };
    },
  };
}

async function preflightAndSelectDestination() {
  const preflight = await runCommand('./ios/scripts/ensure-simulators.sh', [], {
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
    label: 'simulator preflight',
  });
  if (preflight.code !== 0) return { code: preflight.code, destination: null };

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
  const destination = selectIPhoneDestination(simctl);
  if (!destination) throw new Error('No available iPhone exists on the pinned iOS 18.4 runtime');
  const booted = await runCommand(
    'xcrun',
    ['simctl', 'bootstatus', destinationUDID(destination), '-b'],
    {
      timeoutMs: 5 * 60_000,
      label: 'simulator boot',
    },
  );
  if (booted.code !== 0) return { code: booted.code, destination: null };
  return { code: 0, destination };
}

async function runCase(entry, destination) {
  process.stdout.write(`[live-ios] ${entry.scenario}: ${entry.target}\n`);
  const bundlePath = `ios/LiveGateway-${entry.target.replace(/[^A-Za-z0-9._-]+/g, '-')}.xcresult`;
  await rm(resolve(ROOT_DIR, bundlePath), { recursive: true, force: true });
  const harness = startHarness(entry.scenario);
  try {
    const readiness = await harness.readiness;
    const testEnvironment = buildHarnessEnvironment(readiness, entry.scenario);
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
          `-only-testing:${entry.target}`,
          'test',
          'CODE_SIGNING_ALLOWED=NO',
        ],
        {
          env: childEnvironment(testEnvironment),
          timeoutMs: XCODEBUILD_TIMEOUT_MS,
          label: entry.target,
        },
      ),
    );
    const diagnostics = harness.diagnostics();
    let outcome = result.code;
    if (outcome === 0) {
      const summaryResult = await runCommand(
        'xcrun',
        ['xcresulttool', 'get', 'test-results', 'summary', '--path', bundlePath],
        {
          captureStdout: true,
          timeoutMs: 30_000,
          label: `${entry.target} result verification`,
        },
      );
      try {
        if (summaryResult.code !== 0) throw new Error('xcresulttool could not read the result');
        assertSinglePassedTest(JSON.parse(summaryResult.stdout));
      } catch {
        process.stderr.write(
          `[live-ios] ${entry.target} did not execute exactly one passing test\n`,
        );
        outcome = 1;
      }
    }
    if (diagnostics.unexpectedStdout) {
      process.stderr.write('[live-ios] gateway harness emitted unexpected stdout\n');
      outcome = 1;
    }
    if (outcome !== 0 && diagnostics.stderr.length > 0) {
      process.stderr.write('[live-ios] gateway harness reported diagnostics; values redacted\n');
    }
    if (outcome === 0) {
      await rm(resolve(ROOT_DIR, bundlePath), { recursive: true, force: true });
    }
    return outcome;
  } finally {
    await terminate(harness.child);
  }
}

export async function runLiveGatewayTests(entries) {
  const { code, destination } = await preflightAndSelectDestination();
  if (code !== 0 || !destination) return code || 1;
  for (const entry of entries) {
    const result = await runCase(entry, destination);
    if (result !== 0) return result;
  }
  return 0;
}

async function main() {
  const entries = parseRunnerArguments(process.argv.slice(2));
  const code = await runLiveGatewayTests(entries);
  process.exitCode = interruptExitCode ?? code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const onInterrupt = () => handleInterrupt('SIGINT');
  const onTerminate = () => handleInterrupt('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    await main();
  } catch (error) {
    process.stderr.write(`[live-ios] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = interruptExitCode ?? 1;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}
