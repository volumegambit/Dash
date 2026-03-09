import { describe, it, expect, vi } from 'vitest';
import { TelegramAdapter } from './telegram.js';

// Mock grammy to avoid real network/bot initialization
vi.mock('grammy', () => {
  const Bot = vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    catch: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    api: {
      deleteWebhook: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
  }));
  return { Bot };
});

describe('TelegramAdapter health', () => {
  it('starts as connecting', () => {
    const adapter = new TelegramAdapter('fake-token');
    expect(adapter.getHealth()).toBe('connecting');
  });

  it('calls handler on health change', () => {
    const adapter = new TelegramAdapter('fake-token');
    const changes: string[] = [];
    adapter.onHealthChange((h) => changes.push(h));

    (adapter as any).setHealth('connected');

    expect(changes).toContain('connected');
  });

  it('does not call handler if health unchanged', () => {
    const adapter = new TelegramAdapter('fake-token');
    const changes: string[] = [];
    adapter.onHealthChange((h) => changes.push(h));

    (adapter as any).setHealth('connecting'); // same as initial

    expect(changes).toHaveLength(0);
  });
});
