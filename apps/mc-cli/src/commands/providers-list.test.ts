import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProvidersListCommand } from './providers-list.js';

const mockStore = {
  list: vi.fn<[], Promise<string[]>>(),
};

vi.mock('../context.js', () => ({
  ensureUnlocked: vi.fn().mockResolvedValue(undefined),
  getSecretStore: vi.fn(() => mockStore),
}));

describe('providers list', () => {
  let output: string[];

  beforeEach(() => {
    output = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.join(' '));
    });
    mockStore.list.mockResolvedValue([]);
  });

  function buildCommand(): Command {
    const cmd = new Command();
    registerProvidersListCommand(cmd);
    return cmd;
  }

  it('shows "connected" for providers whose secretKey is present', async () => {
    mockStore.list.mockResolvedValue(['anthropic-api-key:default']);
    await buildCommand().parseAsync(['list'], { from: 'user' });
    const joined = output.join('\n');
    expect(joined).toMatch(/Claude by Anthropic.*connected \(default\)/);
    expect(joined).toMatch(/OpenAI.*not connected/);
    expect(joined).toMatch(/Google Gemini.*not connected/);
  });

  it('shows all not connected when store is empty', async () => {
    await buildCommand().parseAsync(['list'], { from: 'user' });
    const joined = output.join('\n');
    expect(joined).toMatch(/Claude by Anthropic.*not connected/);
    expect(joined).toMatch(/OpenAI.*not connected/);
    expect(joined).toMatch(/Google Gemini.*not connected/);
  });
});
