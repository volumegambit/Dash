import type {
  ConversationMessage,
  ConversationPage,
  ConversationSummary,
  MobileWsClientFrame,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatSocket, FrameHandler } from '../api/chat-socket.js';
import type { MobileRestClient } from '../api/rest.js';
import { createWebAppStore } from '../state/store.js';
import { ChatView, RECONNECTING_COPY } from './ChatView.js';
import { WebAppStoreContext } from './Shell.js';

const CONVERSATION_ID = 'conv-1';

function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: CONVERSATION_ID,
    agentId: 'agent-01',
    agentName: 'Mobile Helper',
    title: 'Mobile launch check',
    revision: 1,
    status: 'idle',
    activeTurnId: null,
    owningIssueId: null,
    projectId: null,
    lastSeq: 0,
    lastMessagePreview: null,
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    ...overrides,
  };
}

function message(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'msg-1',
    conversationId: CONVERSATION_ID,
    turnId: 'turn-1',
    ordinal: 1,
    role: 'user',
    status: 'completed',
    content: { type: 'user', text: 'hi' },
    createdAt: '2026-07-12T00:00:01.000Z',
    updatedAt: '2026-07-12T00:00:01.000Z',
    ...overrides,
  };
}

class ScriptedChatSocket {
  readonly sent: MobileWsClientFrame[] = [];
  closed = false;
  sendShouldThrow = false;
  private settle: ((outcome: 'resolve' | 'reject') => void) | null = null;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.settle = (outcome) => (outcome === 'resolve' ? resolve() : reject(new Error('boom')));
    });
  }

  send(frame: MobileWsClientFrame): void {
    if (this.sendShouldThrow) {
      throw new Error('ChatSocket: cannot send while the socket is not open');
    }
    this.sent.push(frame);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.settle?.('resolve');
  }
}

function scriptedSocketFactory() {
  const sockets: ScriptedChatSocket[] = [];
  const onFrames: FrameHandler[] = [];
  const onCloses: Array<(reason: 'error' | 'closed') => void> = [];
  const factory = vi.fn((onFrame: FrameHandler, onClose: (reason: 'error' | 'closed') => void) => {
    const socket = new ScriptedChatSocket();
    sockets.push(socket);
    onFrames.push(onFrame);
    onCloses.push(onClose);
    return socket as unknown as ChatSocket;
  });
  return { factory, sockets, onFrames, onCloses };
}

function fakeRest(conversationPage: ConversationPage, messages: ConversationMessage[] = []) {
  const rest = {
    listConversations: vi.fn(async () => conversationPage),
    getMessages: vi.fn(async () => ({ items: messages, nextCursor: null, throughSeq: 0 })),
  } as unknown as MobileRestClient;
  return rest;
}

async function renderConnected(
  opts: { messages?: ConversationMessage[]; maxAttempts?: number } = {},
) {
  const rest = fakeRest({ items: [summary()], nextCursor: null }, opts.messages ?? []);
  const { factory, sockets, onFrames, onCloses } = scriptedSocketFactory();
  const store = createWebAppStore({
    rest,
    socketFactory: factory,
    reconnect: opts.maxAttempts === undefined ? undefined : { maxAttempts: opts.maxAttempts },
  });
  await store.getState().loadConversations();

  render(
    <WebAppStoreContext.Provider value={store}>
      <ChatView conversationId={CONVERSATION_ID} gatewayLabel="acme" />
    </WebAppStoreContext.Provider>,
  );

  await waitFor(() => expect(sockets.length).toBe(1));
  sockets[0].open();
  await waitFor(() => expect(store.getState().connection).toBe('connected'));

  return { store, sockets, onFrames, onCloses };
}

describe('ChatView', () => {
  it("shows no unreachable banner for a healthy empty account (connection 'idle', no conversation selected)", async () => {
    const rest = fakeRest({ items: [], nextCursor: null }, []);
    const { factory } = scriptedSocketFactory();
    const store = createWebAppStore({ rest, socketFactory: factory });
    await store.getState().loadConversations();
    expect(store.getState().connection).toBe('idle');

    render(
      <WebAppStoreContext.Provider value={store}>
        <ChatView conversationId={null} gatewayLabel="acme" />
      </WebAppStoreContext.Provider>,
    );

    expect(screen.queryByText("Your gateway 'acme' is unreachable.")).toBeNull();
    expect(screen.getByText('Select a conversation to get started.')).toBeTruthy();
  });

  it('renders the transcript replayed from the store', async () => {
    await renderConnected({ messages: [message({ content: { type: 'user', text: 'Ping' } })] });
    expect(screen.getByText('Ping')).toBeTruthy();
  });

  it('updates the streaming assistant content as applyServerFrame processes new event frames', async () => {
    const { sockets, onFrames } = await renderConnected();

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    const turnId = sockets[0].sent[0].id;

    act(() => {
      onFrames[0]({
        type: 'accepted',
        id: turnId,
        conversationId: CONVERSATION_ID,
        userMessageId: 'real-user-id',
        assistantMessageId: 'real-assistant-id',
        revision: 2,
        seq: 1,
      });
      onFrames[0]({
        type: 'event',
        id: turnId,
        conversationId: CONVERSATION_ID,
        seq: 2,
        event: { type: 'text_delta', text: 'Streaming reply' },
      });
    });

    await waitFor(() => expect(screen.getByText('Streaming reply')).toBeTruthy());

    act(() => {
      onFrames[0]({
        type: 'event',
        id: turnId,
        conversationId: CONVERSATION_ID,
        seq: 3,
        event: { type: 'text_delta', text: ' continues' },
      });
    });
    await waitFor(() => expect(screen.getByText('Streaming reply continues')).toBeTruthy());
  });

  it('shows the Reconnecting… banner when the connection drops', async () => {
    const { onCloses } = await renderConnected();
    act(() => onCloses[0]('error'));
    await waitFor(() => expect(screen.getByText(RECONNECTING_COPY)).toBeTruthy());
  });

  it('renders "Your gateway \'acme\' is unreachable." once the store gives up and goes offline', async () => {
    // maxAttempts: 0 makes the very first drop exhaust the retry budget
    // immediately, so `connection` goes straight to `'offline'`.
    const { onCloses } = await renderConnected({ maxAttempts: 0 });
    act(() => onCloses[0]('error'));

    await waitFor(() =>
      expect(screen.getByText("Your gateway 'acme' is unreachable.")).toBeTruthy(),
    );
  });

  it('sends the drafted message and clears the input on accept', async () => {
    const { sockets } = await renderConnected();

    const input = screen.getByLabelText('Message') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hello there' } });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    expect(sockets[0].sent[0]).toMatchObject({ type: 'message', text: 'hello there' });
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('disables the send box while not connected', async () => {
    const { onCloses } = await renderConnected();
    act(() => onCloses[0]('error'));

    await waitFor(() => expect(screen.getByLabelText('Message')).toHaveProperty('disabled', true));
    expect(screen.getByText('Send')).toHaveProperty('disabled', true);
  });

  it('marks the optimistic message failed and shows an inline error when the socket send throws', async () => {
    const { sockets } = await renderConnected();
    sockets[0].sendShouldThrow = true;

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'will fail' } });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => expect(screen.getByText('Failed to send')).toBeTruthy());
  });

  it("renders neither the Reconnecting… banner nor the gateway-unreachable message when connection is 'unauthorized' (Shell routes away; this guard is exhaustive)", async () => {
    const { store } = await renderConnected({
      messages: [message({ content: { type: 'user', text: 'Ping' } })],
    });

    act(() => {
      store.setState({ connection: 'unauthorized' });
    });

    await waitFor(() => expect(screen.queryByText('Ping')).toBeNull());
    expect(screen.queryByText(RECONNECTING_COPY)).toBeNull();
    expect(screen.queryByText("Your gateway 'acme' is unreachable.")).toBeNull();
  });
});

describe('ChatView message copy button', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function stubClipboard() {
    const writeText = vi.fn(() => Promise.resolve());
    // happy-dom's `navigator.clipboard` is a getter with no setter, so a
    // plain `Object.assign(navigator, { clipboard })` throws — redefine the
    // property instead.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    return writeText;
  }

  it('copies the message text to the clipboard and reverts the icon after 1.5s', async () => {
    const writeText = stubClipboard();
    // renderConnected's socket handshake polls via testing-library's
    // waitFor (real timers), so fake timers are switched on only after the
    // connection is established — otherwise waitFor's own polling never
    // fires and the setup hangs.
    await renderConnected({
      messages: [message({ content: { type: 'user', text: 'Ping' } })],
    });
    vi.useFakeTimers();

    const copyButton = screen.getByTitle('Copy message');
    fireEvent.click(copyButton);

    // The clipboard write is a resolved promise; let its .then() run before
    // asserting the "copied" (check icon) state. Promise microtasks aren't
    // gated by fake timers, so a plain await is enough.
    await act(async () => {
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith('Ping');
    expect(copyButton.querySelector('.copy-check')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(copyButton.querySelector('.copy-check')).toBeNull();
  });

  it("copies only an assistant message's concatenated text_delta text, excluding tool output", async () => {
    const writeText = stubClipboard();
    await renderConnected({
      messages: [
        message({
          role: 'assistant',
          content: {
            type: 'assistant',
            events: [
              { type: 'text_delta', text: 'Done. ' },
              { type: 'tool_use_start', id: 'call-1', name: 'bash', input: { command: 'ls' } },
              { type: 'tool_result', id: 'call-1', name: 'bash', content: 'file1' },
              { type: 'text_delta', text: 'All good.' },
            ],
          },
        }),
      ],
    });

    fireEvent.click(screen.getByTitle('Copy message'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith('Done. All good.');
  });

  it('renders no copy button for a tool-only turn (nothing to copy)', async () => {
    await renderConnected({
      messages: [
        message({
          role: 'assistant',
          content: {
            type: 'assistant',
            events: [
              { type: 'tool_use_start', id: 'call-1', name: 'bash', input: { command: 'ls' } },
              { type: 'tool_result', id: 'call-1', name: 'bash', content: 'file1' },
            ],
          },
        }),
      ],
    });

    expect(screen.getByTestId('tool-use-block')).toBeTruthy();
    expect(screen.queryByTitle('Copy message')).toBeNull();
  });
});
