import { access } from 'node:fs/promises';
import type { MobileWsServerFrame } from '@dash/mobile-contract';
import * as acceptanceClient from './mobile-acceptance-client.js';

type AcceptanceClientModule = typeof acceptanceClient & {
  assertDurableFrameIdentity?: (
    frame: MobileWsServerFrame,
    expected: { conversationId: string; turnId: string },
  ) => void;
  createAcceptanceTransportFailureMonitor?: () => {
    onConnectionError(conversationId: string, error: Error): void;
    onProtocolError(conversationId: string, message: string): void;
    assertHealthy(): void;
  };
  withAcceptanceDataDir?: <T>(initialize: (dataDir: string) => Promise<T>) => Promise<T>;
};

const subject = acceptanceClient as AcceptanceClientModule;
const conversationId = '018f0f4a-5c42-7a8b-9c01-1234567890ab';
const turnId = '018f0f4a-5c42-7a8b-9c01-2234567890ab';

describe('Mission Control mobile acceptance client guards', () => {
  it.each([
    {
      label: 'accepted frame for another conversation',
      frame: {
        type: 'accepted',
        id: turnId,
        conversationId: '018f0f4a-5c42-7a8b-9c01-999999999999',
        userMessageId: '018f0f4a-5c42-7a8b-9c01-3234567890ab',
        assistantMessageId: '018f0f4a-5c42-7a8b-9c01-4234567890ab',
        revision: 2,
        seq: 1,
      } satisfies MobileWsServerFrame,
    },
    {
      label: 'terminal frame for another turn',
      frame: {
        type: 'done',
        id: '018f0f4a-5c42-7a8b-9c01-999999999999',
        conversationId,
        seq: 3,
        outcome: 'cancelled',
      } satisfies MobileWsServerFrame,
    },
  ])('rejects a $label', ({ frame }) => {
    expect(subject.assertDurableFrameIdentity).toBeTypeOf('function');
    const assertIdentity = subject.assertDurableFrameIdentity;
    if (!assertIdentity) return;

    expect(() => assertIdentity(frame, { conversationId, turnId })).toThrow(
      /unexpected (conversation|turn)/,
    );
  });

  it.each([
    {
      label: 'connection',
      capture: (monitor: {
        onConnectionError(conversationId: string, error: Error): void;
      }) => monitor.onConnectionError(conversationId, new Error('connection failed')),
      message: 'connection failed',
    },
    {
      label: 'protocol',
      capture: (monitor: {
        onProtocolError(conversationId: string, message: string): void;
      }) => monitor.onProtocolError(conversationId, 'protocol failed'),
      message: 'protocol failed',
    },
  ])('makes a $label callback fatal to acceptance', ({ capture, message }) => {
    expect(subject.createAcceptanceTransportFailureMonitor).toBeTypeOf('function');
    const createMonitor = subject.createAcceptanceTransportFailureMonitor;
    if (!createMonitor) return;
    const monitor = createMonitor();

    capture(monitor);

    expect(() => monitor.assertHealthy()).toThrow(message);
  });

  it('removes the temporary data directory when initialization fails', async () => {
    expect(subject.withAcceptanceDataDir).toBeTypeOf('function');
    const withDataDir = subject.withAcceptanceDataDir;
    if (!withDataDir) return;
    const failure = new Error('identity failed');
    let createdDataDir = '';

    await expect(
      withDataDir(async (dataDir) => {
        createdDataDir = dataDir;
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(access(createdDataDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
