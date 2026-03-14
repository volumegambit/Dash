import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProvidersConnectCommand } from './providers-connect.js';

const mockStore = { set: vi.fn<[string, string], Promise<void>>() };
const mockPrompt = { question: vi.fn<[string], Promise<string>>(), close: vi.fn() };

vi.mock('../context.js', () => ({
  ensureUnlocked: vi.fn().mockResolvedValue(undefined),
  getSecretStore: vi.fn(() => mockStore),
  createPrompt: vi.fn(() => mockPrompt),
}));

describe('providers connect', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockStore.set.mockReset();
    mockStore.set.mockResolvedValue(undefined);
    mockPrompt.question.mockReset();
    mockPrompt.close.mockReset();
  });

  function buildCommand(): Command {
    const cmd = new Command();
    registerProvidersConnectCommand(cmd);
    return cmd;
  }

  it('saves key to store when provider is given as argument', async () => {
    mockPrompt.question.mockResolvedValueOnce('sk-ant-test-key');
    await buildCommand().parseAsync(['connect', 'anthropic'], { from: 'user' });
    expect(mockStore.set).toHaveBeenCalledWith('anthropic-api-key:default', 'sk-ant-test-key');
  });

  it('shows a numbered menu when no provider arg given and saves on selection', async () => {
    mockPrompt.question
      .mockResolvedValueOnce('1') // pick provider #1 (anthropic)
      .mockResolvedValueOnce('sk-ant-test-key');
    await buildCommand().parseAsync(['connect'], { from: 'user' });
    expect(mockStore.set).toHaveBeenCalledWith('anthropic-api-key:default', 'sk-ant-test-key');
  });

  it('errors on unknown provider arg', async () => {
    await buildCommand().parseAsync(['connect', 'unknownprovider'], { from: 'user' });
    expect(mockStore.set).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Unknown provider'));
  });

  it('errors when empty key entered', async () => {
    mockPrompt.question.mockResolvedValueOnce(''); // empty key
    await buildCommand().parseAsync(['connect', 'openai'], { from: 'user' });
    expect(mockStore.set).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('required'));
  });
});
