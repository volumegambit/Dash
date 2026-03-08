import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProvidersDisconnectCommand } from './providers-disconnect.js';

const mockStore = {
  list: vi.fn<[], Promise<string[]>>(),
  delete: vi.fn<[string], Promise<void>>(),
};
const mockPrompt = { question: vi.fn<[string], Promise<string>>(), close: vi.fn() };

vi.mock('../context.js', () => ({
  ensureUnlocked: vi.fn().mockResolvedValue(undefined),
  getSecretStore: vi.fn(() => mockStore),
  createPrompt: vi.fn(() => mockPrompt),
}));

describe('providers disconnect', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockStore.delete.mockReset();
    mockStore.delete.mockResolvedValue(undefined);
    mockStore.list.mockReset();
    mockPrompt.question.mockReset();
    mockPrompt.close.mockReset();
  });

  function buildCommand(): Command {
    const cmd = new Command();
    registerProvidersDisconnectCommand(cmd);
    return cmd;
  }

  it('deletes the key after confirmation', async () => {
    mockStore.list.mockResolvedValue(['anthropic-api-key']);
    mockPrompt.question.mockResolvedValueOnce('y');
    await buildCommand().parseAsync(['disconnect', 'anthropic'], { from: 'user' });
    expect(mockStore.delete).toHaveBeenCalledWith('anthropic-api-key');
  });

  it('does not delete when confirmation is declined', async () => {
    mockStore.list.mockResolvedValue(['anthropic-api-key']);
    mockPrompt.question.mockResolvedValueOnce('n');
    await buildCommand().parseAsync(['disconnect', 'anthropic'], { from: 'user' });
    expect(mockStore.delete).not.toHaveBeenCalled();
  });

  it('errors when provider is not connected', async () => {
    mockStore.list.mockResolvedValue([]);
    await buildCommand().parseAsync(['disconnect', 'anthropic'], { from: 'user' });
    expect(mockStore.delete).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not connected'));
  });

  it('errors on unknown provider', async () => {
    mockStore.list.mockResolvedValue(['anthropic-api-key']);
    await buildCommand().parseAsync(['disconnect', 'unknownprovider'], { from: 'user' });
    expect(mockStore.delete).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Unknown provider'));
  });
});
