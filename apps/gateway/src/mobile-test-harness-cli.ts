import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  type MobileTestHarnessScenario,
  type RunningMobileTestHarness,
  startMobileTestHarness,
} from './mobile-test-harness.js';

const scenarios = new Set<MobileTestHarnessScenario>([
  'stream',
  'question',
  'slow',
  'follow-up-v2',
  'follow-up-v2-restart',
  'follow-up-v1-fallback',
]);

export type MobileTestHarnessReadyFrame = {
  type: 'ready';
  managementBaseUrl: string;
  chatWebSocketUrl: string;
  mobileBaseUrl: string;
  mobileChatWebSocketUrl: string;
  tlsCertificateSha256: string;
  managementToken: string;
  chatToken: string;
  gatewayId: string;
  agentId: string;
  dataDir: string;
};

export type MobileTestHarnessControlCommand = {
  type: 'restart';
  requestId: string;
};

export type MobileTestHarnessControlFrame =
  | MobileTestHarnessReadyFrame
  | { type: 'restarted'; requestId: string }
  | {
      type: 'control_error';
      requestId: string | null;
      code: 'invalid_command' | 'restart_in_progress' | 'restart_unavailable' | 'restart_failed';
    };

interface MobileTestHarnessCliSignalSource {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface MobileTestHarnessCliOptions {
  args: string[];
  input: Readable;
  output: Writable;
  errorOutput: Writable;
  startHarness(options: {
    scenario: MobileTestHarnessScenario;
  }): Promise<RunningMobileTestHarness>;
  signals: MobileTestHarnessCliSignalSource;
  exit(code: number): void;
}

export interface MobileTestHarnessCliHandle {
  completion: Promise<void>;
  dispose(): Promise<void>;
}

export function parseMobileTestHarnessScenario(args: string[]): MobileTestHarnessScenario {
  if (args.length === 0) return 'stream';
  const scenario = args[1] as MobileTestHarnessScenario | undefined;
  if (args.length !== 2 || args[0] !== '--scenario' || !scenario || !scenarios.has(scenario)) {
    throw new Error(
      'Usage: mobile:test-harness -- --scenario stream|question|slow|follow-up-v2|follow-up-v2-restart|follow-up-v1-fallback',
    );
  }
  return scenario;
}

function writeFrame(output: Writable, frame: MobileTestHarnessControlFrame): void {
  output.write(`${JSON.stringify(frame)}\n`);
}

function parseControl(
  line: string,
):
  | { command: MobileTestHarnessControlCommand; requestId: string }
  | { command: null; requestId: string | null } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { command: null, requestId: null };
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { command: null, requestId: null };
  }
  const record = value as Record<string, unknown>;
  const requestId =
    typeof record.requestId === 'string' && record.requestId.trim().length > 0
      ? record.requestId
      : null;
  if (record.type !== 'restart' || requestId === null) {
    return { command: null, requestId };
  }
  return { command: { type: 'restart', requestId }, requestId };
}

export async function runMobileTestHarnessCli(
  options: MobileTestHarnessCliOptions,
): Promise<MobileTestHarnessCliHandle> {
  const scenario = parseMobileTestHarnessScenario(options.args);
  const harness = await options.startHarness({ scenario });
  const reader = createInterface({ input: options.input, crlfDelay: Number.POSITIVE_INFINITY });
  let stopping = false;
  let settled = false;
  let restartInFlight: Promise<void> | null = null;
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolvePromise) => {
    resolveCompletion = resolvePromise;
  });

  const onLine = (line: string): void => {
    const parsed = parseControl(line);
    if (!parsed.command) {
      writeFrame(options.output, {
        type: 'control_error',
        requestId: parsed.requestId,
        code: 'invalid_command',
      });
      return;
    }
    if (stopping || scenario !== 'follow-up-v2-restart') {
      writeFrame(options.output, {
        type: 'control_error',
        requestId: parsed.requestId,
        code: 'restart_unavailable',
      });
      return;
    }
    if (restartInFlight) {
      writeFrame(options.output, {
        type: 'control_error',
        requestId: parsed.requestId,
        code: 'restart_in_progress',
      });
      return;
    }

    const requestId = parsed.command.requestId;
    const restart = Promise.resolve()
      .then(() => harness.restartGateway())
      .then(() => {
        writeFrame(options.output, { type: 'restarted', requestId });
      })
      .catch(() => {
        writeFrame(options.output, {
          type: 'control_error',
          requestId,
          code: 'restart_failed',
        });
      })
      .finally(() => {
        if (restartInFlight === restart) restartInFlight = null;
      });
    restartInFlight = restart;
  };

  reader.on('line', onLine);

  const cleanup = (): void => {
    reader.removeListener('line', onLine);
    reader.close();
    options.signals.removeListener('SIGINT', onSigint);
    options.signals.removeListener('SIGTERM', onSigterm);
  };

  const settle = async (exitAfter: boolean, signal?: 'SIGINT' | 'SIGTERM'): Promise<void> => {
    if (settled) return completion;
    settled = true;
    stopping = true;
    if (signal) options.errorOutput.write(`[mobile-test-harness] received ${signal}; stopping\n`);
    let exitCode = 0;
    try {
      await restartInFlight;
      await harness.stop();
    } catch {
      exitCode = 1;
      options.errorOutput.write('[mobile-test-harness] shutdown failed\n');
    } finally {
      cleanup();
      resolveCompletion();
      if (exitAfter) options.exit(exitCode);
    }
  };

  const onSigint = (): void => {
    stopping = true;
    void settle(true, 'SIGINT');
  };
  const onSigterm = (): void => {
    stopping = true;
    void settle(true, 'SIGTERM');
  };
  options.signals.once('SIGINT', onSigint);
  options.signals.once('SIGTERM', onSigterm);

  options.errorOutput.write(`[mobile-test-harness] ready (${scenario})\n`);
  writeFrame(options.output, {
    type: 'ready',
    managementBaseUrl: harness.managementBaseUrl,
    chatWebSocketUrl: harness.chatWebSocketUrl,
    mobileBaseUrl: harness.mobileBaseUrl,
    mobileChatWebSocketUrl: harness.mobileChatWebSocketUrl,
    tlsCertificateSha256: harness.tlsCertificateSha256,
    managementToken: harness.managementToken,
    chatToken: harness.chatToken,
    gatewayId: harness.gatewayId,
    agentId: harness.agentId,
    dataDir: harness.dataDir,
  });

  return {
    completion,
    dispose: () => settle(false),
  };
}

async function runDirectly(): Promise<void> {
  try {
    const handle = await runMobileTestHarnessCli({
      args: process.argv.slice(2),
      input: process.stdin,
      output: process.stdout,
      errorOutput: process.stderr,
      startHarness: startMobileTestHarness,
      signals: process,
      exit: (code) => process.exit(code),
    });
    await handle.completion;
  } catch {
    process.stderr.write('[mobile-test-harness] failed\n');
    process.exit(1);
  }
}

const directEntryPath = process.argv[1];
if (directEntryPath && fileURLToPath(import.meta.url) === resolve(directEntryPath)) {
  void runDirectly();
}
