import makeWASocket from '@whiskeysockets/baileys';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageHandler } from '../types.js';
import { makeBaileysAuthState } from './whatsapp-auth.js';
import { WhatsAppAdapter } from './whatsapp.js';

// Mock Baileys at module level
const mockSock = {
  ev: {
    on: vi.fn(),
    off: vi.fn(),
  },
  sendMessage: vi.fn().mockResolvedValue(undefined),
  end: vi.fn(),
};

vi.mock('@whiskeysockets/baileys', async () => {
  const actual =
    await vi.importActual<typeof import('@whiskeysockets/baileys')>('@whiskeysockets/baileys');
  return {
    ...actual,
    default: vi.fn(() => mockSock),
  };
});

vi.mock('qrcode-terminal', () => ({
  default: { generate: vi.fn() },
}));

vi.mock('./whatsapp-auth.js', () => ({
  makeBaileysAuthState: vi.fn().mockResolvedValue({
    state: { creds: {}, keys: { get: vi.fn(), set: vi.fn() } },
    saveCreds: vi.fn(),
  }),
}));

// Mock the file system to avoid writing to disk
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  writeFile: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

describe('WhatsAppAdapter', () => {
  let adapter: WhatsAppAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock to fresh state after clearAllMocks restores defaults
    mockSock.ev.on.mockImplementation(() => {});
    mockSock.ev.off.mockImplementation(() => {});
    mockSock.sendMessage.mockResolvedValue(undefined);
    adapter = new WhatsAppAdapter({}, '/tmp/test-wa-auth');
  });

  it('name is "whatsapp"', () => {
    expect(adapter.name).toBe('whatsapp');
  });

  it('sends a text message via sock.sendMessage', async () => {
    await adapter.start();
    await adapter.send('1234567890@s.whatsapp.net', { text: 'Hello!' });
    expect(mockSock.sendMessage).toHaveBeenCalledWith('1234567890@s.whatsapp.net', {
      text: 'Hello!',
    });
  });

  it('ends the captured socket and settles a held send promptly when aborted', async () => {
    await adapter.start();
    const connectionUpdate = mockSock.ev.on.mock.calls.find(
      (args: unknown[]) => args[0] === 'connection.update',
    )?.[1] as ((update: { connection: string }) => void) | undefined;
    mockSock.end.mockImplementationOnce(() => connectionUpdate?.({ connection: 'close' }));
    const releaseSend = Promise.withResolvers<void>();
    mockSock.sendMessage.mockReturnValueOnce(releaseSend.promise);
    const controller = new AbortController();
    const sending = adapter.send(
      '1234567890@s.whatsapp.net',
      { text: 'held reply' },
      controller.signal,
    );

    try {
      controller.abort();
      expect(mockSock.end).toHaveBeenCalledOnce();
      expect(mockSock.end).toHaveBeenCalledWith(undefined);
      await expect(sending).rejects.toThrow('send aborted');
      await Promise.resolve();
      expect(makeWASocket).toHaveBeenCalledOnce();

      releaseSend.resolve();
      await Promise.resolve();
      await expect(
        adapter.send('1234567890@s.whatsapp.net', { text: 'late reply' }),
      ).rejects.toThrow('not started');
      expect(mockSock.sendMessage).toHaveBeenCalledOnce();
    } finally {
      releaseSend.resolve();
      await Promise.allSettled([sending, adapter.stop()]);
    }
  });

  it('keeps a shared socket live when one agent-scoped send aborts', async () => {
    const replacementSock = {
      ev: { on: vi.fn(), off: vi.fn() },
      sendMessage: vi.fn().mockResolvedValue(undefined),
      end: vi.fn(),
    };
    vi.mocked(makeWASocket)
      .mockReturnValueOnce(mockSock as never)
      .mockReturnValueOnce(replacementSock as never);
    await adapter.start();
    const releaseFirstSend = Promise.withResolvers<void>();
    const lateSendSettled = Promise.withResolvers<void>();
    let capturedSocketRetired = false;
    let lateDelivery = false;
    mockSock.end.mockImplementationOnce(() => {
      capturedSocketRetired = true;
    });
    mockSock.sendMessage.mockImplementationOnce(async () => {
      await releaseFirstSend.promise;
      if (!capturedSocketRetired) lateDelivery = true;
      lateSendSettled.resolve();
    });
    const controller = new AbortController();
    const firstSend = adapter.send(
      'agent-a@s.whatsapp.net',
      { text: 'held agent A reply' },
      controller.signal,
    );

    try {
      controller.abort({
        code: 'gateway_admission_aborted',
        scope: 'agent',
        agentId: 'agent-a',
        message: "Agent 'agent-a' lifecycle started",
      });
      await expect(firstSend).rejects.toThrow('send aborted');
      expect(mockSock.end).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(makeWASocket).toHaveBeenCalledTimes(2));

      await expect(
        adapter.send('agent-b@s.whatsapp.net', { text: 'unaffected agent B reply' }),
      ).resolves.toBeUndefined();
      expect(replacementSock.sendMessage).toHaveBeenCalledWith('agent-b@s.whatsapp.net', {
        text: 'unaffected agent B reply',
      });
      releaseFirstSend.resolve();
      await lateSendSettled.promise;
      expect(lateDelivery).toBe(false);
    } finally {
      releaseFirstSend.resolve();
      await Promise.allSettled([firstSend, adapter.stop()]);
    }
  });

  it('does not install a deferred agent-abort replacement after stop', async () => {
    await adapter.start();
    const authHeld = Promise.withResolvers<Awaited<ReturnType<typeof makeBaileysAuthState>>>();
    vi.mocked(makeBaileysAuthState).mockReturnValueOnce(authHeld.promise);
    const releaseSend = Promise.withResolvers<void>();
    mockSock.sendMessage.mockReturnValueOnce(releaseSend.promise);
    const controller = new AbortController();
    const sending = adapter.send('agent-a@s.whatsapp.net', { text: 'held' }, controller.signal);
    controller.abort({
      code: 'gateway_admission_aborted',
      scope: 'agent',
      agentId: 'agent-a',
      message: "Agent 'agent-a' lifecycle started",
    });

    try {
      await expect(sending).rejects.toThrow('send aborted');
      await vi.waitFor(() => expect(makeBaileysAuthState).toHaveBeenCalledTimes(2));
      await adapter.stop();
      authHeld.resolve({
        state: { creds: {}, keys: { get: vi.fn(), set: vi.fn() } } as never,
        saveCreds: vi.fn(),
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(makeWASocket).toHaveBeenCalledOnce();
    } finally {
      releaseSend.resolve();
      authHeld.resolve({
        state: { creds: {}, keys: { get: vi.fn(), set: vi.fn() } } as never,
        saveCreds: vi.fn(),
      });
      await Promise.allSettled([sending, adapter.stop()]);
    }
  });

  it('calls onMessage handlers for incoming DM text', async () => {
    const handler: MessageHandler = vi.fn();
    adapter.onMessage(handler);
    await adapter.start();

    // Get the 'messages.upsert' listener registered via sock.ev.on
    const upsertCall = (mockSock.ev.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (args: unknown[]) => args[0] === 'messages.upsert',
    );
    expect(upsertCall).toBeDefined();
    const upsertHandler = upsertCall?.[1] as (data: unknown) => Promise<void>;

    await upsertHandler({
      messages: [
        {
          key: { remoteJid: '1234@s.whatsapp.net', fromMe: false },
          message: { conversation: 'Hello from DM' },
          pushName: 'Alice',
          messageTimestamp: 1700000000,
        },
      ],
      type: 'notify',
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'whatsapp',
        conversationId: '1234@s.whatsapp.net',
        senderId: '1234@s.whatsapp.net',
        senderName: 'Alice',
        text: 'Hello from DM',
      }),
    );
  });

  it('uses participant as senderId for group messages', async () => {
    const handler: MessageHandler = vi.fn();
    adapter.onMessage(handler);
    await adapter.start();

    const upsertCall = (mockSock.ev.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (args: unknown[]) => args[0] === 'messages.upsert',
    );
    const upsertHandler = upsertCall?.[1] as (data: unknown) => Promise<void>;

    await upsertHandler({
      messages: [
        {
          key: {
            remoteJid: 'group123@g.us',
            fromMe: false,
            participant: '5678@s.whatsapp.net',
          },
          message: { conversation: 'Hello group' },
          pushName: 'Bob',
          messageTimestamp: 1700000000,
        },
      ],
      type: 'notify',
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'group123@g.us',
        senderId: '5678@s.whatsapp.net',
        text: 'Hello group',
      }),
    );
  });

  it('skips messages from self (fromMe: true)', async () => {
    const handler: MessageHandler = vi.fn();
    adapter.onMessage(handler);
    await adapter.start();

    const upsertCall = (mockSock.ev.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (args: unknown[]) => args[0] === 'messages.upsert',
    );
    const upsertHandler = upsertCall?.[1] as (data: unknown) => Promise<void>;

    await upsertHandler({
      messages: [
        {
          key: { remoteJid: '1234@s.whatsapp.net', fromMe: true },
          message: { conversation: 'My own message' },
          messageTimestamp: 1700000000,
        },
      ],
      type: 'notify',
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('skips non-text messages with a console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler: MessageHandler = vi.fn();
    adapter.onMessage(handler);
    await adapter.start();

    const upsertCall = (mockSock.ev.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (args: unknown[]) => args[0] === 'messages.upsert',
    );
    const upsertHandler = upsertCall?.[1] as (data: unknown) => Promise<void>;

    await upsertHandler({
      messages: [
        {
          key: { remoteJid: '1234@s.whatsapp.net', fromMe: false },
          message: { imageMessage: { url: 'https://example.com/img.jpg' } },
          messageTimestamp: 1700000000,
        },
      ],
      type: 'notify',
    });

    expect(handler).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('non-text'));
    warnSpy.mockRestore();
  });

  it('ignores messages.upsert events with type !== notify', async () => {
    const handler: MessageHandler = vi.fn();
    adapter.onMessage(handler);
    await adapter.start();

    const upsertCall = (mockSock.ev.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (args: unknown[]) => args[0] === 'messages.upsert',
    );
    const upsertHandler = upsertCall?.[1] as (data: unknown) => Promise<void>;

    await upsertHandler({
      messages: [
        {
          key: { remoteJid: '1234@s.whatsapp.net', fromMe: false },
          message: { conversation: 'hi' },
          messageTimestamp: 0,
        },
      ],
      type: 'append', // not 'notify'
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('stop() calls sock.end when started', async () => {
    await adapter.start();
    await adapter.stop();
    expect(mockSock.end).toHaveBeenCalledWith(undefined);
  });

  it('send() throws when not started', async () => {
    await expect(adapter.send('1234@s.whatsapp.net', { text: 'hi' })).rejects.toThrow();
  });
});

describe('WhatsAppAdapter health', () => {
  it('starts as connecting', () => {
    const adapter = new WhatsAppAdapter({}, '/tmp/test-auth');
    expect(adapter.getHealth()).toBe('connecting');
  });

  it('calls health change handler when setHealth is called', () => {
    const adapter = new WhatsAppAdapter({}, '/tmp/test-auth');
    const changes: string[] = [];
    adapter.onHealthChange((h) => changes.push(h));

    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for test
    (adapter as any).setHealth('needs_reauth');

    expect(changes).toContain('needs_reauth');
  });

  it('does not call handler if health unchanged', () => {
    const adapter = new WhatsAppAdapter({}, '/tmp/test-auth');
    const changes: string[] = [];
    adapter.onHealthChange((h) => changes.push(h));

    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for test
    (adapter as any).setHealth('connecting'); // same as initial

    expect(changes).toHaveLength(0);
  });
});
