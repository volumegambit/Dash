import { describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../types.js';
import { TelegramAdapter } from './telegram.js';

// Shared mock state used by the allow-list tests to capture the
// `message:text` handler that grammy would normally invoke, plus the most
// recently constructed mock bot so send/start/stop tests can assert
// directly against its api spies.
let capturedTextHandler: ((ctx: unknown) => Promise<void>) | null = null;
let capturedErrorHandler: ((err: unknown) => void) | null = null;
let capturedStartOpts: {
  drop_pending_updates?: boolean;
  onStart?: (botInfo: { username: string }) => void;
} | null = null;
let lastBot: MockBot | null = null;
const replyMock = vi.fn().mockResolvedValue(undefined);

interface MockBot {
  on: ReturnType<typeof vi.fn>;
  catch: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  api: {
    deleteWebhook: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
  };
}

// Mock only the grammy transport boundary (Bot constructor + its network
// methods). The adapter's own event-handler logic, allow-list resolution,
// and health-state machine all run real code.
vi.mock('grammy', () => {
  const Bot = vi.fn().mockImplementation(() => {
    const bot: MockBot = {
      on: vi.fn().mockImplementation((event: string, handler: (ctx: unknown) => Promise<void>) => {
        if (event === 'message:text') {
          capturedTextHandler = handler;
        }
      }),
      catch: vi.fn().mockImplementation((handler: (err: unknown) => void) => {
        capturedErrorHandler = handler;
      }),
      start: vi.fn().mockImplementation((opts) => {
        capturedStartOpts = opts;
        return Promise.resolve();
      }),
      stop: vi.fn().mockResolvedValue(undefined),
      api: {
        deleteWebhook: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
    };
    lastBot = bot;
    return bot;
  });
  return { Bot };
});

/** Build a fake grammy context for the `message:text` handler. */
function makeCtx(opts: {
  fromId: number;
  username?: string;
  firstName?: string;
  chatId: number;
  text: string;
}): Record<string, unknown> {
  return {
    from: { id: opts.fromId, username: opts.username, first_name: opts.firstName ?? 'User' },
    chat: { id: opts.chatId },
    message: { text: opts.text, date: Math.floor(Date.now() / 1000) },
    reply: replyMock,
  };
}

describe('TelegramAdapter health', () => {
  it('starts as connecting', () => {
    const adapter = new TelegramAdapter('fake-token');
    expect(adapter.getHealth()).toBe('connecting');
  });

  it('calls handler on health change', () => {
    const adapter = new TelegramAdapter('fake-token');
    const changes: string[] = [];
    adapter.onHealthChange((h) => changes.push(h));

    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for test
    (adapter as any).setHealth('connected');

    expect(changes).toContain('connected');
  });

  it('does not call handler if health unchanged', () => {
    const adapter = new TelegramAdapter('fake-token');
    const changes: string[] = [];
    adapter.onHealthChange((h) => changes.push(h));

    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for test
    (adapter as any).setHealth('connecting'); // same as initial

    expect(changes).toHaveLength(0);
  });
});

describe('TelegramAdapter allowedUsers', () => {
  // `capturedTextHandler` and `replyMock` are shared with the grammy mock
  // above; each test constructs a fresh adapter so the previous handler is
  // overwritten.

  async function trigger(ctx: Record<string, unknown>): Promise<void> {
    if (!capturedTextHandler) throw new Error('handler not captured');
    await capturedTextHandler(ctx);
  }

  function freshAdapter(allowedUsers: Parameters<typeof TelegramAdapter>[1]): {
    adapter: TelegramAdapter;
    received: InboundMessage[];
  } {
    replyMock.mockClear();
    capturedTextHandler = null;
    const adapter = new TelegramAdapter('fake-token', allowedUsers);
    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });
    return { adapter, received };
  }

  it('with empty array allows every sender (backwards-compat default)', async () => {
    const { received } = freshAdapter([]);
    await trigger(makeCtx({ fromId: 1, chatId: 10, text: 'hi' }));
    expect(received).toHaveLength(1);
    expect(received[0].senderId).toBe('1');
    expect(replyMock).not.toHaveBeenCalled();
  });

  it('with static array: blocks non-matching senders and replies', async () => {
    const { received } = freshAdapter(['@alice']);
    await trigger(makeCtx({ fromId: 2, username: 'bob', chatId: 10, text: 'hi' }));
    expect(received).toHaveLength(0);
    expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('not authorized'));
  });

  it('with static array: matches by numeric ID, bare username, or @username', async () => {
    const { received: recById } = freshAdapter(['42']);
    await trigger(makeCtx({ fromId: 42, chatId: 10, text: 'by-id' }));
    expect(recById).toHaveLength(1);

    const { received: recByBare } = freshAdapter(['alice']);
    await trigger(makeCtx({ fromId: 1, username: 'alice', chatId: 10, text: 'by-bare' }));
    expect(recByBare).toHaveLength(1);

    const { received: recByAt } = freshAdapter(['@alice']);
    await trigger(makeCtx({ fromId: 1, username: 'alice', chatId: 10, text: 'by-at' }));
    expect(recByAt).toHaveLength(1);
  });

  it('with function form: resolves the list on every message (live updates)', async () => {
    // A mutable list — simulating the gateway's registry lookup whose
    // contents change when an operator PUTs the channel.
    let live: string[] = ['@alice'];
    const { received } = freshAdapter(() => live);

    // Alice passes the initial filter
    await trigger(makeCtx({ fromId: 1, username: 'alice', chatId: 10, text: 'first' }));
    expect(received).toHaveLength(1);

    // Operator removes Alice and adds Bob — no adapter restart
    live = ['@bob'];

    // Alice is now blocked
    await trigger(makeCtx({ fromId: 1, username: 'alice', chatId: 10, text: 'second' }));
    expect(received).toHaveLength(1);
    expect(replyMock).toHaveBeenCalledTimes(1);

    // Bob is now allowed
    await trigger(makeCtx({ fromId: 2, username: 'bob', chatId: 10, text: 'third' }));
    expect(received).toHaveLength(2);
    expect(received[1].senderId).toBe('2');
  });

  it('with function form: empty return disables filtering entirely', async () => {
    const { received } = freshAdapter(() => []);
    await trigger(makeCtx({ fromId: 99, chatId: 10, text: 'hi' }));
    expect(received).toHaveLength(1);
    expect(replyMock).not.toHaveBeenCalled();
  });

  it('with function form: a resolver that throws fails closed (drops the message)', async () => {
    const { received } = freshAdapter(() => {
      throw new Error('registry unreachable');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await trigger(makeCtx({ fromId: 1, username: 'alice', chatId: 10, text: 'hi' }));
      expect(received).toHaveLength(0);
      expect(replyMock).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('getAllowedUsers resolver threw'),
        expect.anything(),
      );
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ── Inbound message shape ────────────────────────────────────────────────

describe('TelegramAdapter inbound messages', () => {
  async function trigger(ctx: Record<string, unknown>): Promise<void> {
    if (!capturedTextHandler) throw new Error('handler not captured');
    await capturedTextHandler(ctx);
  }

  it('normalizes a grammy context into an InboundMessage with correct fields', async () => {
    capturedTextHandler = null;
    const adapter = new TelegramAdapter('fake-token');
    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    const timestamp = 1_700_000_000;
    await trigger({
      from: { id: 7, username: 'alice', first_name: 'Alice', last_name: 'Anderson' },
      chat: { id: -100_123 },
      message: { text: 'hello world', date: timestamp },
      reply: replyMock,
    });

    expect(received).toHaveLength(1);
    const msg = received[0];
    expect(msg.channelId).toBe('telegram');
    expect(msg.conversationId).toBe('-100123');
    expect(msg.senderId).toBe('7');
    expect(msg.senderName).toBe('Alice Anderson');
    expect(msg.text).toBe('hello world');
    // Seconds → milliseconds conversion: date*1000
    expect(msg.timestamp).toEqual(new Date(timestamp * 1000));
  });

  it('omits the last name from senderName when not present', async () => {
    capturedTextHandler = null;
    const adapter = new TelegramAdapter('fake-token');
    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await trigger({
      from: { id: 1, username: 'alice', first_name: 'Alice' },
      chat: { id: 10 },
      message: { text: 'hi', date: 1_700_000_000 },
      reply: replyMock,
    });

    expect(received[0].senderName).toBe('Alice');
  });

  it('isolates misbehaving message handlers so one throwing handler does not block the others', async () => {
    capturedTextHandler = null;
    const adapter = new TelegramAdapter('fake-token');

    const received: string[] = [];
    adapter.onMessage(async () => {
      received.push('handler-A-called');
      throw new Error('handler-A boom');
    });
    adapter.onMessage(async () => {
      received.push('handler-B-called');
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await trigger({
        from: { id: 1, first_name: 'User' },
        chat: { id: 10 },
        message: { text: 'hi', date: 1_700_000_000 },
        reply: replyMock,
      });

      // Both handlers ran even though A threw
      expect(received).toEqual(['handler-A-called', 'handler-B-called']);
      // The throw was logged, not swallowed silently
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('message handler threw'),
        expect.anything(),
      );
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ── Outbound messages via send() ──────────────────────────────────────────

describe('TelegramAdapter.send', () => {
  it('calls bot.api.sendMessage with the numeric chat ID and message text', async () => {
    const adapter = new TelegramAdapter('fake-token');
    await adapter.send('12345', { text: 'outbound hello' });

    expect(lastBot).not.toBeNull();
    expect(lastBot?.api.sendMessage).toHaveBeenCalledWith(
      12345,
      'outbound hello',
      // parseMode is undefined when not specified
      { parse_mode: undefined },
    );
  });

  it('propagates parseMode to the grammy API call', async () => {
    const adapter = new TelegramAdapter('fake-token');
    await adapter.send('42', { text: '**bold**', parseMode: 'Markdown' });

    expect(lastBot?.api.sendMessage).toHaveBeenCalledWith(42, '**bold**', {
      parse_mode: 'Markdown',
    });
  });

  it('rejects when the underlying API call rejects', async () => {
    const adapter = new TelegramAdapter('fake-token');
    // Replace the success mock with a rejection for this single call
    if (!lastBot) throw new Error('bot not captured');
    lastBot.api.sendMessage.mockRejectedValueOnce(new Error('429 rate limited'));

    await expect(adapter.send('1', { text: 'x' })).rejects.toThrow('429 rate limited');
  });
});

// ── Lifecycle: start / stop / polling errors ─────────────────────────────

describe('TelegramAdapter lifecycle', () => {
  it('start() drops pending updates, registers a bot.catch handler, and calls bot.start', async () => {
    const adapter = new TelegramAdapter('fake-token');
    await adapter.start();

    expect(lastBot?.api.deleteWebhook).toHaveBeenCalledWith({ drop_pending_updates: true });
    expect(lastBot?.catch).toHaveBeenCalled();
    expect(lastBot?.start).toHaveBeenCalled();
    // bot.start is passed drop_pending_updates:true
    expect(capturedStartOpts?.drop_pending_updates).toBe(true);
  });

  it('start() onStart callback transitions health from connecting to connected', async () => {
    const adapter = new TelegramAdapter('fake-token');
    const changes: string[] = [];
    adapter.onHealthChange((h) => changes.push(h));

    expect(adapter.getHealth()).toBe('connecting');
    await adapter.start();

    // Invoke the onStart callback grammy would call after polling begins
    capturedStartOpts?.onStart?.({ username: 'testbot' });

    expect(adapter.getHealth()).toBe('connected');
    expect(changes).toEqual(['connected']);
  });

  it('start() bot.catch handler transitions health to disconnected', async () => {
    const adapter = new TelegramAdapter('fake-token');
    const changes: string[] = [];
    adapter.onHealthChange((h) => changes.push(h));
    // Put the adapter in 'connected' first so the disconnect transition is visible
    await adapter.start();
    capturedStartOpts?.onStart?.({ username: 'testbot' });
    changes.length = 0;

    // Simulate grammy reporting a runtime error via bot.catch
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      capturedErrorHandler?.(new Error('polling dropped'));
    } finally {
      errSpy.mockRestore();
    }

    expect(adapter.getHealth()).toBe('disconnected');
    expect(changes).toEqual(['disconnected']);
  });

  it('start() is non-fatal when deleteWebhook fails at startup', async () => {
    const adapter = new TelegramAdapter('fake-token');
    if (!lastBot) throw new Error('bot not captured');
    lastBot.api.deleteWebhook.mockRejectedValueOnce(new Error('network down'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(adapter.start()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('deleteWebhook at startup failed'),
        expect.anything(),
      );
      // bot.start was still called — startup failure in deleteWebhook is non-fatal
      expect(lastBot.start).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('stop() calls bot.stop, sets health to disconnected, and clears health handlers', async () => {
    const adapter = new TelegramAdapter('fake-token');
    const changes: string[] = [];
    adapter.onHealthChange((h) => changes.push(h));
    // First connect so we can see the transition to disconnected
    await adapter.start();
    capturedStartOpts?.onStart?.({ username: 'testbot' });
    changes.length = 0;

    await adapter.stop();

    expect(lastBot?.stop).toHaveBeenCalled();
    expect(adapter.getHealth()).toBe('disconnected');
    expect(changes).toEqual(['disconnected']);

    // After stop, further health changes should NOT call any handler
    // (setHealth('connecting') is a change from 'disconnected'; if a
    // handler were still registered it would fire)
    changes.length = 0;
    // biome-ignore lint/suspicious/noExplicitAny: accessing private method for test
    (adapter as any).setHealth('connecting');
    expect(changes).toEqual([]);
  });
});
