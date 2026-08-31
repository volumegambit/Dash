import type {
  ConversationMessage,
  ConversationPage,
  ConversationSummary,
  MobileWsClientFrame,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ChatSocket, FrameHandler } from '../api/chat-socket.js';
import type { MobileRestClient } from '../api/rest.js';
import { createWebAppStore } from '../state/store.js';
import { ChatView, RECONNECTING_COPY } from './ChatView.js';
import { WebAppStoreContext } from './Shell.js';
import { ContentBlocks } from './blocks/ContentBlocks.js';

// Spies on ContentBlocks while preserving its real rendering, so the
// memoization test below (`MessageRow` should not re-render confirmed
// messages on every streaming token) can count calls without mocking away
// actual markdown/tool-card output that every other test in this file
// depends on.
vi.mock('./blocks/ContentBlocks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./blocks/ContentBlocks.js')>();
  return { ...actual, ContentBlocks: vi.fn(actual.ContentBlocks) };
});

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

  it('does not throw when navigator.clipboard is undefined (insecure context)', async () => {
    // happy-dom's `navigator.clipboard` is a getter with no setter, so
    // `Object.assign` throws — redefine the property to simulate an
    // insecure context, where the browser doesn't expose the Clipboard API
    // at all (accessing `.writeText` on it would otherwise be a synchronous
    // TypeError inside the click handler).
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });

    await renderConnected({
      messages: [message({ content: { type: 'user', text: 'Ping' } })],
    });

    const copyButton = screen.getByTitle('Copy message');
    expect(() => fireEvent.click(copyButton)).not.toThrow();
    // No state change: still shows the copy icon, not the "copied" check.
    expect(copyButton.querySelector('.copy-check')).toBeNull();
  });
});

describe('ChatView shell structure (chat-ux Phase 2 Task 1, audit #1)', () => {
  it('keeps the composer in document flow, outside the scroll container, with 50 messages', async () => {
    const messages = Array.from({ length: 50 }, (_, i) =>
      message({ id: `msg-${i}`, content: { type: 'user', text: `Message number ${i}` } }),
    );
    await renderConnected({ messages });

    // The scroll container (Task 3's future IntersectionObserver target)
    // holds every message...
    const transcript = screen.getByTestId('chat-transcript');
    expect(within(transcript).getByText('Message number 0')).toBeTruthy();
    expect(within(transcript).getByText('Message number 49')).toBeTruthy();

    // ...while the composer (send box) is a sibling of the transcript, not a
    // descendant of it — so it can never scroll off-screen with the
    // messages, regardless of how many pile up.
    const messageInput = screen.getByLabelText('Message');
    expect(within(transcript).queryByLabelText('Message')).toBeNull();
    expect(messageInput).toBeTruthy();
    expect(screen.getByText('Send')).toBeTruthy();
  });

  it('renders the transcript and composer as siblings under a single app-main shell root', async () => {
    await renderConnected({
      messages: [message({ content: { type: 'user', text: 'Ping' } })],
    });

    const transcript = screen.getByTestId('chat-transcript');
    const shellRoot = transcript.closest('.app-main');
    expect(shellRoot).toBeTruthy();
    // The composer lives inside the same shell root, in its own row.
    expect(
      shellRoot?.querySelector('.app-composer-row textarea[aria-label="Message"]'),
    ).toBeTruthy();
  });
});

describe('ChatView composer (chat-ux Phase 2 Task 2, audit #3/#14)', () => {
  it('Enter sends the drafted message; Shift+Enter does not', async () => {
    const { sockets } = await renderConnected();
    const textarea = screen.getByLabelText('Message');

    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(sockets[0].sent).toHaveLength(0);

    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    expect(sockets[0].sent[0]).toMatchObject({ type: 'message', text: 'hello' });
  });

  it('ignores Enter while an IME composition is in progress (isComposing, and the legacy keyCode 229 fallback)', async () => {
    const { sockets } = await renderConnected();
    const textarea = screen.getByLabelText('Message');

    fireEvent.change(textarea, { target: { value: 'こんにちは' } });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });

    expect(sockets[0].sent).toHaveLength(0);
  });

  it('autogrows the textarea by matching its scrollHeight on every keystroke', async () => {
    await renderConnected();
    const textarea = screen.getByLabelText('Message') as HTMLTextAreaElement;

    // happy-dom (like jsdom) never lays out real content, so `scrollHeight`
    // is otherwise always 0 — stub it to a multi-line value to exercise the
    // resize effect (ChatView.tsx: `ta.style.height = scrollHeight + 'px'`).
    // The visual clamp itself (`max-height: 40dvh`) is a CSS rule, asserted
    // separately in styles.test.ts — jsdom/happy-dom can't compute it.
    Object.defineProperty(textarea, 'scrollHeight', { value: 96, configurable: true });
    fireEvent.change(textarea, { target: { value: 'line one\nline two\nline three' } });

    await waitFor(() => expect(textarea.style.height).toBe('96px'));
  });

  it('shows a stop button (not Send) while a turn is streaming, and calls cancelTurn on click', async () => {
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
    });

    const stopButton = await screen.findByLabelText('Stop response');
    expect(screen.queryByText('Send')).toBeNull();

    fireEvent.click(stopButton);
    await waitFor(() =>
      expect(sockets[0].sent).toContainEqual(
        expect.objectContaining({ type: 'cancel', id: turnId }),
      ),
    );

    act(() => {
      onFrames[0]({
        type: 'done',
        id: turnId,
        conversationId: CONVERSATION_ID,
        seq: 2,
        outcome: 'cancelled',
      });
    });

    await waitFor(() => expect(screen.queryByLabelText('Stop response')).toBeNull());
    expect(screen.getByText('Send')).toBeTruthy();
  });

  it('keeps drafts isolated per conversation — switching away and back restores the original draft without leaking it onto the other thread (audit #14)', async () => {
    const OTHER_ID = 'conv-2';
    const rest = fakeRest({ items: [summary(), summary({ id: OTHER_ID })], nextCursor: null }, []);
    const { factory, sockets } = scriptedSocketFactory();
    const store = createWebAppStore({ rest, socketFactory: factory });
    await store.getState().loadConversations();

    const { rerender } = render(
      <WebAppStoreContext.Provider value={store}>
        <ChatView conversationId={CONVERSATION_ID} gatewayLabel="acme" />
      </WebAppStoreContext.Provider>,
    );
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].open();
    await waitFor(() => expect(store.getState().connection).toBe('connected'));

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'draft for A' } });

    rerender(
      <WebAppStoreContext.Provider value={store}>
        <ChatView conversationId={OTHER_ID} gatewayLabel="acme" />
      </WebAppStoreContext.Provider>,
    );
    await waitFor(() => expect(sockets.length).toBe(2));
    sockets[1].open();
    await waitFor(() => expect(store.getState().connection).toBe('connected'));

    // Thread B never saw thread A's draft.
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'draft for B' } });

    rerender(
      <WebAppStoreContext.Provider value={store}>
        <ChatView conversationId={CONVERSATION_ID} gatewayLabel="acme" />
      </WebAppStoreContext.Provider>,
    );
    await waitFor(() => expect(sockets.length).toBe(3));
    sockets[2].open();
    await waitFor(() => expect(store.getState().connection).toBe('connected'));

    // Thread A's draft survived the round trip.
    await waitFor(() =>
      expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('draft for A'),
    );

    rerender(
      <WebAppStoreContext.Provider value={store}>
        <ChatView conversationId={OTHER_ID} gatewayLabel="acme" />
      </WebAppStoreContext.Provider>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('draft for B'),
    );
  });

  it('clears the draft map entry for a conversation once its message actually sends', async () => {
    const OTHER_ID = 'conv-2';
    const rest = fakeRest({ items: [summary(), summary({ id: OTHER_ID })], nextCursor: null }, []);
    const { factory, sockets } = scriptedSocketFactory();
    const store = createWebAppStore({ rest, socketFactory: factory });
    await store.getState().loadConversations();

    const { rerender } = render(
      <WebAppStoreContext.Provider value={store}>
        <ChatView conversationId={CONVERSATION_ID} gatewayLabel="acme" />
      </WebAppStoreContext.Provider>,
    );
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].open();
    await waitFor(() => expect(store.getState().connection).toBe('connected'));

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'sent from A' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    await waitFor(() =>
      expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe(''),
    );

    rerender(
      <WebAppStoreContext.Provider value={store}>
        <ChatView conversationId={OTHER_ID} gatewayLabel="acme" />
      </WebAppStoreContext.Provider>,
    );
    await waitFor(() => expect(sockets.length).toBe(2));
    sockets[1].open();
    await waitFor(() => expect(store.getState().connection).toBe('connected'));

    rerender(
      <WebAppStoreContext.Provider value={store}>
        <ChatView conversationId={CONVERSATION_ID} gatewayLabel="acme" />
      </WebAppStoreContext.Provider>,
    );
    await waitFor(() => expect(sockets.length).toBe(3));
    sockets[2].open();
    await waitFor(() => expect(store.getState().connection).toBe('connected'));

    // Back on A: the sent draft was cleared, not resurrected.
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
  });
});

describe('ChatView message row memoization', () => {
  beforeEach(() => {
    vi.mocked(ContentBlocks).mockClear();
  });

  it('does not re-render a confirmed message row while the streaming message updates', async () => {
    const { onFrames, sockets } = await renderConnected({
      messages: [message({ content: { type: 'user', text: 'Ping' } })],
    });

    function confirmedMessageRenderCount(): number {
      // Filter specifically on the seeded 'Ping' message's text, not just
      // `type: 'user'`: sending the "hello" draft below adds its own,
      // legitimately-new optimistic `type: 'user'` message to the
      // transcript, which would otherwise inflate this count for reasons
      // unrelated to what's being tested here (the *unchanged* 'Ping'
      // message re-rendering when it shouldn't).
      return vi
        .mocked(ContentBlocks)
        .mock.calls.filter(
          ([props]) => props.content.type === 'user' && props.content.text === 'Ping',
        ).length;
    }

    await waitFor(() => expect(confirmedMessageRenderCount()).toBeGreaterThan(0));
    const before = confirmedMessageRenderCount();

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

    // Two more `event` frames landed (each re-renders ChatView, per
    // assemble.ts's `applyServerFrame`), but the confirmed 'Ping' message's
    // reference never changed — a memoized row must not have re-rendered
    // for it.
    expect(confirmedMessageRenderCount()).toBe(before);
  });
});
