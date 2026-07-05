import { beforeEach, describe, expect, it } from 'vitest';
import { mockApi } from '../../../../vitest.setup.js';
import { useChatStore } from './chat.js';

const msg = {
  id: 'm1',
  role: 'assistant' as const,
  content: { type: 'assistant' as const, events: [] },
  timestamp: '2026-07-05T00:00:00Z',
};

beforeEach(() => {
  useChatStore.setState({ messages: {}, sending: {}, streamingEvents: {} });
});

describe('useChatStore.ensureMessages', () => {
  it('loads messages once for a conversation not yet in the store', async () => {
    mockApi.chatGetMessages.mockResolvedValue([msg]);

    await useChatStore.getState().ensureMessages('conv-42');

    expect(mockApi.chatGetMessages).toHaveBeenCalledWith('conv-42');
    expect(useChatStore.getState().messages['conv-42']).toEqual([msg]);
  });

  it('is a no-op when messages are already loaded', async () => {
    useChatStore.setState({ messages: { 'conv-42': [msg] } });

    await useChatStore.getState().ensureMessages('conv-42');

    expect(mockApi.chatGetMessages).not.toHaveBeenCalled();
  });
});
