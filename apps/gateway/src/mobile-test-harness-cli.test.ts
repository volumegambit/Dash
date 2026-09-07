import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import * as cliModule from './mobile-test-harness-cli.js';
import type { RunningMobileTestHarness } from './mobile-test-harness.js';

interface CliModule {
  parseMobileTestHarnessScenario(args: string[]): string;
  runMobileTestHarnessCli(options: {
    args: string[];
    input: PassThrough;
    output: PassThrough;
    errorOutput: PassThrough;
    startHarness: (options: { scenario: string }) => Promise<RunningMobileTestHarness>;
    signals: EventEmitter;
    exit(code: number): void;
  }): Promise<{
    completion: Promise<void>;
    dispose(): Promise<void>;
  }>;
}

interface FakeHarnessControls {
  harness: RunningMobileTestHarness;
  restartGateway: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

class JsonlInbox {
  readonly values: unknown[] = [];
  private buffer = '';
  private readonly listeners = new Set<() => void>();

  constructor(stream: PassThrough) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      this.buffer += chunk;
      while (true) {
        const newline = this.buffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > 0) this.values.push(JSON.parse(line));
      }
      for (const listener of this.listeners) listener();
    });
  }

  async at(index: number): Promise<unknown> {
    if (index < this.values.length) return this.values[index];
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(
          new Error(`Timed out waiting for JSONL index ${index}: ${JSON.stringify(this.values)}`),
        );
      }, 2_000);
      const check = (): void => {
        if (index >= this.values.length) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(this.values[index]);
      };
      this.listeners.add(check);
    });
  }
}

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function loadCliModule(): Promise<CliModule> {
  const source = await readFile(new URL('./mobile-test-harness-cli.ts', import.meta.url), 'utf8');
  expect(source).toContain('export async function runMobileTestHarnessCli');
  return cliModule as unknown as CliModule;
}

function fakeHarness(
  restartImplementation: () => Promise<void> = async () => {},
): FakeHarnessControls {
  const restartGateway = vi.fn(restartImplementation);
  const stop = vi.fn(async () => {});
  const harness = {
    managementBaseUrl: 'http://127.0.0.1:41001',
    chatWebSocketUrl: 'ws://127.0.0.1:41002/ws/chat',
    mobileBaseUrl: 'https://127.0.0.1:41003',
    mobileChatWebSocketUrl: 'wss://127.0.0.1:41003/ws/chat',
    tlsCertificateSha256: 'a'.repeat(64),
    managementToken: 'management-secret-must-not-leak',
    chatToken: 'chat-secret-must-not-leak',
    gatewayId: 'gateway-stable',
    publicKey: 'public-key',
    agentId: 'agent-stable',
    dataDir: '/tmp/dash-cli-fixture',
    restartGateway,
    stop,
  } as unknown as RunningMobileTestHarness;
  return { harness, restartGateway, stop };
}

async function startCli(
  options: {
    scenario?: string;
    fake?: FakeHarnessControls;
  } = {},
): Promise<{
  input: PassThrough;
  output: PassThrough;
  errorOutput: PassThrough;
  outputInbox: JsonlInbox;
  signals: EventEmitter;
  exits: number[];
  fake: FakeHarnessControls;
  handle: Awaited<ReturnType<CliModule['runMobileTestHarnessCli']>>;
}> {
  const cli = await loadCliModule();
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const outputInbox = new JsonlInbox(output);
  const signals = new EventEmitter();
  const exits: number[] = [];
  const fake = options.fake ?? fakeHarness();
  const handle = await cli.runMobileTestHarnessCli({
    args: ['--scenario', options.scenario ?? 'follow-up-v2-restart'],
    input,
    output,
    errorOutput,
    startHarness: async () => fake.harness,
    signals,
    exit: (code) => exits.push(code),
  });
  return { input, output, errorOutput, outputInbox, signals, exits, fake, handle };
}

describe('mobile test harness CLI scenarios and control', () => {
  it('parses every legacy and Follow Up v2 CLI scenario exactly', async () => {
    const cli = await loadCliModule();
    for (const scenario of [
      'stream',
      'question',
      'slow',
      'follow-up-v2',
      'follow-up-v2-restart',
      'follow-up-v1-fallback',
    ]) {
      expect(cli.parseMobileTestHarnessScenario(['--scenario', scenario])).toBe(scenario);
    }
    expect(() => cli.parseMobileTestHarnessScenario(['--scenario', 'follow_up_v2'])).toThrow(
      /follow-up-v2/,
    );
  });

  it('is import-safe and emits only a ready JSONL frame before input', async () => {
    const cli = await startCli();
    try {
      expect(await cli.outputInbox.at(0)).toEqual({
        type: 'ready',
        managementBaseUrl: cli.fake.harness.managementBaseUrl,
        chatWebSocketUrl: cli.fake.harness.chatWebSocketUrl,
        mobileBaseUrl: cli.fake.harness.mobileBaseUrl,
        mobileChatWebSocketUrl: cli.fake.harness.mobileChatWebSocketUrl,
        tlsCertificateSha256: cli.fake.harness.tlsCertificateSha256,
        managementToken: cli.fake.harness.managementToken,
        chatToken: cli.fake.harness.chatToken,
        gatewayId: cli.fake.harness.gatewayId,
        agentId: cli.fake.harness.agentId,
        dataDir: cli.fake.harness.dataDir,
      });
      expect(cli.outputInbox.values).toHaveLength(1);
      expect(cli.fake.restartGateway).not.toHaveBeenCalled();
      expect(cli.fake.stop).not.toHaveBeenCalled();
    } finally {
      await cli.handle.dispose();
    }
  });

  it('acknowledges one CLI scenario restart only after service recreation settles', async () => {
    const restart = deferred();
    const cli = await startCli({ fake: fakeHarness(() => restart.promise) });
    try {
      await cli.outputInbox.at(0);
      cli.input.write('{"type":"restart","requestId":"restart-1"}\n');
      await vi.waitFor(() => expect(cli.fake.restartGateway).toHaveBeenCalledOnce());
      expect(cli.outputInbox.values).toHaveLength(1);
      restart.resolve();
      expect(await cli.outputInbox.at(1)).toEqual({ type: 'restarted', requestId: 'restart-1' });
      expect(cli.exits).toEqual([]);
    } finally {
      await cli.handle.dispose();
    }
  });

  it('recovers after malformed and invalid control lines without echoing secrets', async () => {
    const cli = await startCli();
    try {
      await cli.outputInbox.at(0);
      cli.input.write('not json\n');
      cli.input.write('{"type":"unknown","requestId":"unknown-1","secret":"leak-me"}\n');
      cli.input.write('{"type":"restart","requestId":""}\n');
      cli.input.write('{"type":"restart","requestId":"   "}\n');
      cli.input.write('{"type":"restart","requestId":42}\n');
      cli.input.write('{"type":"restart","requestId":"restart-valid"}\n');
      expect(await cli.outputInbox.at(1)).toEqual({
        type: 'control_error',
        requestId: null,
        code: 'invalid_command',
      });
      expect(await cli.outputInbox.at(2)).toEqual({
        type: 'control_error',
        requestId: 'unknown-1',
        code: 'invalid_command',
      });
      expect(await cli.outputInbox.at(3)).toEqual({
        type: 'control_error',
        requestId: null,
        code: 'invalid_command',
      });
      expect(await cli.outputInbox.at(4)).toEqual({
        type: 'control_error',
        requestId: null,
        code: 'invalid_command',
      });
      expect(await cli.outputInbox.at(5)).toEqual({
        type: 'control_error',
        requestId: null,
        code: 'invalid_command',
      });
      expect(await cli.outputInbox.at(6)).toEqual({
        type: 'restarted',
        requestId: 'restart-valid',
      });
      const output = JSON.stringify(cli.outputInbox.values.slice(1));
      expect(output).not.toContain('leak-me');
      expect(output).not.toContain(cli.fake.harness.managementToken);
      expect(output).not.toContain(cli.fake.harness.chatToken);
      expect(cli.exits).toEqual([]);
    } finally {
      await cli.handle.dispose();
    }
  });

  it('returns restart_in_progress when a second line races the pending restart', async () => {
    const restart = deferred();
    const cli = await startCli({ fake: fakeHarness(() => restart.promise) });
    try {
      await cli.outputInbox.at(0);
      cli.input.write('{"type":"restart","requestId":"restart-first"}\n');
      cli.input.write('{"type":"restart","requestId":"restart-overlap"}\n');
      expect(await cli.outputInbox.at(1)).toEqual({
        type: 'control_error',
        requestId: 'restart-overlap',
        code: 'restart_in_progress',
      });
      expect(cli.fake.restartGateway).toHaveBeenCalledOnce();
      restart.resolve();
      expect(await cli.outputInbox.at(2)).toEqual({
        type: 'restarted',
        requestId: 'restart-first',
      });
    } finally {
      await cli.handle.dispose();
    }
  });

  it.each(['stream', 'question', 'slow', 'follow-up-v2', 'follow-up-v1-fallback'])(
    'returns restart_unavailable for non-restart CLI scenario %s',
    async (scenario) => {
      const cli = await startCli({ scenario });
      try {
        await cli.outputInbox.at(0);
        cli.input.write('{"type":"restart","requestId":"restart-denied"}\n');
        expect(await cli.outputInbox.at(1)).toEqual({
          type: 'control_error',
          requestId: 'restart-denied',
          code: 'restart_unavailable',
        });
        expect(cli.fake.restartGateway).not.toHaveBeenCalled();
        expect(cli.exits).toEqual([]);
      } finally {
        await cli.handle.dispose();
      }
    },
  );

  it('emits restart_failed without the thrown message and permits a safe retry', async () => {
    let attempts = 0;
    const fake = fakeHarness(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('listener 41003 leaked chat-secret-must-not-leak');
    });
    const cli = await startCli({ fake });
    try {
      await cli.outputInbox.at(0);
      cli.input.write('{"type":"restart","requestId":"restart-fails"}\n');
      expect(await cli.outputInbox.at(1)).toEqual({
        type: 'control_error',
        requestId: 'restart-fails',
        code: 'restart_failed',
      });
      expect(JSON.stringify(cli.outputInbox.values.slice(1))).not.toContain('listener 41003');
      expect(JSON.stringify(cli.outputInbox.values.slice(1))).not.toContain('chat-secret');

      cli.input.write('{"type":"restart","requestId":"restart-retry"}\n');
      expect(await cli.outputInbox.at(2)).toEqual({
        type: 'restarted',
        requestId: 'restart-retry',
      });
      expect(fake.restartGateway).toHaveBeenCalledTimes(2);
      expect(cli.exits).toEqual([]);
    } finally {
      await cli.handle.dispose();
    }
  });

  it('orders shutdown after an in-flight restart and rejects later controls', async () => {
    const restart = deferred();
    const cli = await startCli({ fake: fakeHarness(() => restart.promise) });
    try {
      await cli.outputInbox.at(0);
      cli.input.write('{"type":"restart","requestId":"restart-before-signal"}\n');
      await vi.waitFor(() => expect(cli.fake.restartGateway).toHaveBeenCalledOnce());
      cli.signals.emit('SIGTERM', 'SIGTERM');
      cli.input.write('{"type":"restart","requestId":"restart-after-signal"}\n');
      expect(await cli.outputInbox.at(1)).toEqual({
        type: 'control_error',
        requestId: 'restart-after-signal',
        code: 'restart_unavailable',
      });
      expect(cli.fake.stop).not.toHaveBeenCalled();
      restart.resolve();
      expect(await cli.outputInbox.at(2)).toEqual({
        type: 'restarted',
        requestId: 'restart-before-signal',
      });
      await cli.handle.completion;
      expect(cli.fake.stop).toHaveBeenCalledOnce();
      expect(cli.exits).toEqual([0]);
    } finally {
      await cli.handle.dispose();
    }
  });

  it('treats stdin EOF as neither restart nor shutdown and exposes explicit disposal', async () => {
    const cli = await startCli();
    let completed = false;
    void cli.handle.completion.then(() => {
      completed = true;
    });
    await cli.outputInbox.at(0);
    cli.input.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(cli.fake.restartGateway).not.toHaveBeenCalled();
    expect(cli.fake.stop).not.toHaveBeenCalled();
    expect(completed).toBe(false);
    await cli.handle.dispose();
    await cli.handle.completion;
    expect(cli.fake.stop).toHaveBeenCalledOnce();
    expect(cli.exits).toEqual([]);
  });
});
