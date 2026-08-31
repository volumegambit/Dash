import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import * as mobileE2E from './mobile-v1-e2e.mjs';

interface CleanupAction {
  label: string;
  run(): void | Promise<void>;
}

type AcceptanceDriverModule = typeof mobileE2E & {
  assertExpectedCapableFrame?: (
    frame: unknown,
    expected: { turnId: string; conversationId: string },
  ) => { seq: number };
  runCleanupActions?: (actions: CleanupAction[]) => Promise<void>;
  runWithDeadlineAndCleanup?: <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    cleanup: CleanupAction[],
    label: string,
    timeoutMs: number,
  ) => Promise<T>;
  acquireAcceptanceResource?: <T>(
    signal: AbortSignal,
    resource: Promise<T>,
    cleanup: (value: T) => void | Promise<void>,
  ) => Promise<T>;
};

const driver = mobileE2E as AcceptanceDriverModule;
const conversationId = '018f0f4a-5c42-7a8b-9c01-1234567890ab';
const turnId = '018f0f4a-5c42-7a8b-9c01-2234567890ab';

async function closeServer(server: WebSocketServer): Promise<void> {
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('mobile v1 acceptance driver guards', () => {
  it('requires every capable frame to carry the expected identity and durable sequence', () => {
    expect(driver.assertExpectedCapableFrame).toBeTypeOf('function');
    const assertFrame = driver.assertExpectedCapableFrame;
    if (!assertFrame) return;

    expect(() =>
      assertFrame(
        {
          type: 'event',
          id: turnId,
          conversationId,
          event: { type: 'text_delta', text: 'missing sequence' },
        },
        { turnId, conversationId },
      ),
    ).toThrow('missing a durable sequence');
    expect(() =>
      assertFrame(
        {
          type: 'event',
          id: turnId,
          conversationId: '018f0f4a-5c42-7a8b-9c01-999999999999',
          seq: 2,
          event: { type: 'text_delta', text: 'misrouted' },
        },
        { turnId, conversationId },
      ),
    ).toThrow('unexpected conversation');
  });

  it('does not claim an empty sequence observation is contiguous', async () => {
    const client = await mobileE2E.openContractClient({});

    expect(client.sequenceWasContiguous).toBe(false);
    await client.close();
  });

  it('removes a timed-out waiter before delivering the next frame', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (typeof address === 'string' || !address) throw new Error('WebSocket listener has no port');
    const socket = await mobileE2E.openSocket({
      chatWebSocketUrl: `ws://127.0.0.1:${address.port}`,
      chatToken: 'fixed-fake-chat-token',
    });

    try {
      await expect(mobileE2E.nextFrame(socket, 5)).rejects.toThrow(
        'Timed out waiting for chat frame',
      );
      const peer = [...server.clients][0];
      if (!peer) throw new Error('WebSocket peer did not connect');
      peer.send(JSON.stringify({ type: 'event', id: 'after-timeout' }));

      await expect(mobileE2E.nextFrame(socket, 1_000)).resolves.toEqual({
        type: 'event',
        id: 'after-timeout',
      });
    } finally {
      socket.terminate();
      await closeServer(server);
    }
  });

  it('attempts every cleanup action and propagates their failures', async () => {
    expect(driver.runCleanupActions).toBeTypeOf('function');
    const cleanup = driver.runCleanupActions;
    if (!cleanup) return;
    const attempts: string[] = [];
    const failure = new Error('first cleanup failed');

    const result = cleanup([
      {
        label: 'first',
        run() {
          attempts.push('first');
          throw failure;
        },
      },
      {
        label: 'second',
        run() {
          attempts.push('second');
        },
      },
    ]);

    await expect(result).rejects.toMatchObject({ errors: [failure] });
    expect(attempts).toEqual(['first', 'second']);
  });

  it('runs cleanup after the scenario deadline expires', async () => {
    expect(driver.runWithDeadlineAndCleanup).toBeTypeOf('function');
    const run = driver.runWithDeadlineAndCleanup;
    if (!run) return;
    const attempts: string[] = [];

    const result = run(
      () => new Promise<never>(() => {}),
      [
        {
          label: 'deadline cleanup',
          run() {
            attempts.push('cleanup');
          },
        },
      ],
      'test acceptance scenario',
      5,
    );

    await expect(result).rejects.toThrow('Timed out waiting for test acceptance scenario');
    expect(attempts).toEqual(['cleanup']);
  });

  it('cleans a resource that becomes ready after its deadline has expired', async () => {
    expect(driver.acquireAcceptanceResource).toBeTypeOf('function');
    const acquire = driver.acquireAcceptanceResource;
    if (!acquire) return;
    const controller = new AbortController();
    const deadline = new Error('deadline expired');
    const cleaned: string[] = [];
    controller.abort(deadline);

    const result = acquire(controller.signal, Promise.resolve('late gateway'), (resource) => {
      cleaned.push(resource);
    });

    await expect(result).rejects.toBe(deadline);
    expect(cleaned).toEqual(['late gateway']);
  });
});

describe('mobile v1 real gateway acceptance', () => {
  it('keeps desktop-shaped and ios-shaped clients on one canonical transcript', async () => {
    const report = await mobileE2E.runMobileV1Acceptance();

    expect(report.healthCapabilities).toEqual(['conversation-sync-v1', 'chat-resume-v1']);
    expect(report.acceptedTurnId).toBe(report.replayedTurnId);
    expect(report.desktopTranscript).toEqual(report.iosTranscript);
    expect(report.desktopTranscript.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(report.sequenceWasContiguous).toBe(true);
    expect(report.staleRenameStatus).toBe(409);
    expect(report.busyErrorCode).toBe('conversation_busy');
    expect(report.cancelOutcome).toBe('cancelled');
    expect(report.concurrentRefreshMatched).toBe(true);
    expect(report.archivedAfterAgentDelete).toBe(true);
  }, 30_000);
});
