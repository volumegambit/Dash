import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageHandler } from '../types.js';
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

    // Access private method for testing
    (adapter as any).setHealth('needs_reauth');

    expect(changes).toContain('needs_reauth');
  });

  it('does not call handler if health unchanged', () => {
    const adapter = new WhatsAppAdapter({}, '/tmp/test-auth');
    const changes: string[] = [];
    adapter.onHealthChange((h) => changes.push(h));

    (adapter as any).setHealth('connecting'); // same as initial

    expect(changes).toHaveLength(0);
  });
});
