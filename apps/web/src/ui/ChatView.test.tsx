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
import {
  ChatView,
  EMPTY_CHAT_GREETING,
  RECONNECTING_COPY,
  RESEND_BLOCKED_COPY,
  STARTER_PROMPTS,
} from './ChatView.js';
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

  it('shows a Thinking… indicator pre-first-token and swaps it for a streaming caret once ' +
    'content arrives (chat-ux Phase 2 Task 5, audit #13)', async () => {
    const { sockets, onFrames } = await renderConnected();

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    const turnId = sockets[0].sent[0].id;

    // Right after `accepted`, before any `event` frame: `streaming` is a
    // non-null empty-events shell (`assemble.ts`) — this is exactly the
    // "no visible event yet" window MC's `ThinkingIndicator` fills.
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

    await waitFor(() => expect(screen.getByTestId('thinking-indicator')).toBeTruthy());
    expect(screen.queryByTestId('streaming-caret')).toBeNull();

    act(() => {
      onFrames[0]({
        type: 'event',
        id: turnId,
        conversationId: CONVERSATION_ID,
        seq: 2,
        event: { type: 'text_delta', text: 'Streaming reply' },
      });
    });

    // First visible content flips the indicator off and the caret on.
    await waitFor(() => expect(screen.getByTestId('streaming-caret')).toBeTruthy());
    expect(screen.queryByTestId('thinking-indicator')).toBeNull();
  });

  it('fix I1: announces a streamed turn\'s lifecycle in a polite live region — "Assistant is ' +
    'replying" on start, then the finalized reply text on done — WITHOUT making the whole ' +
    'transcript aria-live (which would spam a screen reader on every token)', async () => {
    const { sockets, onFrames } = await renderConnected();

    const liveRegion = screen.getByTestId('chat-live-region');
    expect(liveRegion.getAttribute('aria-live')).toBe('polite');
    expect(liveRegion.textContent).toBe('');
    // Not on the transcript itself — the scrolling container that
    // actually re-renders per streamed token.
    expect(screen.getByTestId('chat-transcript').getAttribute('aria-live')).toBeNull();

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
    await waitFor(() => expect(liveRegion.textContent).toBe('Assistant is replying'));

    // Tokens streaming in must NOT re-announce (or spam the live region)
    // — only the start/end transitions do.
    act(() => {
      onFrames[0]({
        type: 'event',
        id: turnId,
        conversationId: CONVERSATION_ID,
        seq: 2,
        event: { type: 'text_delta', text: 'Final reply text' },
      });
    });
    await waitFor(() => expect(screen.getByText('Final reply text')).toBeTruthy());
    expect(liveRegion.textContent).toBe('Assistant is replying');

    act(() => {
      onFrames[0]({ type: 'done', id: turnId, conversationId: CONVERSATION_ID, seq: 3 });
    });
    await waitFor(() => expect(liveRegion.textContent).toBe('Final reply text'));
  });

  it('fix I1: announces "Response failed" when the finalized assistant message ends up failed', async () => {
    const { store } = await renderConnected({
      messages: [
        message({
          id: 'user-1',
          role: 'user',
          turnId: 'turn-1',
          content: { type: 'user', text: 'Ping' },
        }),
      ],
    });

    const liveRegion = screen.getByTestId('chat-live-region');

    // Simulate a turn that was mid-stream and finalized failed (mirrors how
    // the gateway's `finishTurn` marks the assistant row `'failed'`) —
    // directly through the store so this test doesn't depend on the exact
    // frame sequence that produces that state server-side.
    act(() => {
      store.setState((state) => ({
        transcripts: {
          ...state.transcripts,
          [CONVERSATION_ID]: {
            ...state.transcripts[CONVERSATION_ID],
            streaming: { type: 'assistant', events: [] },
          },
        },
      }));
    });
    await waitFor(() => expect(liveRegion.textContent).toBe('Assistant is replying'));

    act(() => {
      store.setState((state) => ({
        transcripts: {
          ...state.transcripts,
          [CONVERSATION_ID]: {
            ...state.transcripts[CONVERSATION_ID],
            streaming: null,
            messages: [
              ...state.transcripts[CONVERSATION_ID].messages,
              message({
                id: 'assistant-1',
                role: 'assistant',
                turnId: 'turn-1',
                status: 'failed',
                content: { type: 'assistant', events: [] },
              }),
            ],
          },
        },
      }));
    });

    await waitFor(() => expect(liveRegion.textContent).toBe('Response failed'));
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

/**
 * `usePinnedScroll`'s own test suite (`ui/hooks/usePinnedScroll.test.ts`)
 * covers the pin/unpin/auto-scroll state machine directly via a mocked
 * `IntersectionObserver` — jsdom/happy-dom's real one never fires a
 * callback from actual layout, so that's the only place the state
 * transitions are actually exercised. This is deliberately just the
 * "sentinel wiring smoke" the task 3 brief calls for: proof `ChatView`
 * mounts the sentinel in the right place and starts pinned (no pill), not a
 * re-test of the hook's own logic.
 */
describe('ChatView scroll pinning wiring (chat-ux Phase 2 Task 3, audit #4)', () => {
  it('mounts a bottom sentinel inside the transcript, after the last message', async () => {
    await renderConnected({
      messages: [message({ content: { type: 'user', text: 'Ping' } })],
    });

    const transcript = screen.getByTestId('chat-transcript');
    const sentinel = within(transcript).getByTestId('chat-transcript-sentinel');
    expect(sentinel).toBeTruthy();

    // "After the last message": the sentinel is the transcript's last child,
    // not interleaved before/between messages (which would make its
    // intersection state lag behind newly-appended content).
    const column = sentinel.parentElement;
    expect(column?.lastElementChild).toBe(sentinel);
  });

  it('starts pinned — no jump-to-bottom pill on initial render', async () => {
    await renderConnected({
      messages: [message({ content: { type: 'user', text: 'Ping' } })],
    });

    expect(screen.queryByLabelText('Jump to latest')).toBeNull();
  });

  /**
   * Regression (fix C2): `usePinnedScroll` is called unconditionally inside
   * `ChatView`, ABOVE the `if (!conversationId)` early return — so the very
   * first time a session's `ChatView` mounts, `conversationId` is `null`
   * (nothing picked yet in `ChatWorkspace`'s `selectedConversationId`
   * state), the transcript/sentinel markup the hook's refs attach to isn't
   * rendered at all, and `ChatView` is never unmounted/remounted just for
   * picking a conversation afterward. Before the fix, the hook's
   * observer-mounting effect ran its ONE allotted time against unattached
   * refs and never got a second chance — pinning/auto-scroll/jump-to-bottom
   * were silently inert for every conversation opened first in a session.
   * Exercised here through the REAL global `IntersectionObserver` (stubbed
   * only to spy on it, matching how `ChatView` actually calls the hook — no
   * `createObserver` prop exists on `ChatView` itself) rather than the
   * hook's own injected-fake test seam, so this specifically covers the
   * wiring between `ChatView` and the hook, not the hook's internal state
   * machine (already covered by `usePinnedScroll.test.ts`).
   */
  it('creates the IntersectionObserver once a conversation is picked, even though ChatView first mounted with conversationId=null', async () => {
    const rest = fakeRest({ items: [summary()], nextCursor: null }, []);
    const { factory, sockets } = scriptedSocketFactory();
    const store = createWebAppStore({ rest, socketFactory: factory });
    await store.getState().loadConversations();

    const observeSpy = vi.fn();
    const ctorSpy = vi.fn(() => ({
      observe: observeSpy,
      unobserve: vi.fn(),
      disconnect: vi.fn(),
      takeRecords: () => [],
    }));
    vi.stubGlobal('IntersectionObserver', ctorSpy);

    const { rerender } = render(
      <WebAppStoreContext.Provider value={store}>
        <ChatView conversationId={null} gatewayLabel="acme" />
      </WebAppStoreContext.Provider>,
    );

    // No transcript/sentinel exists yet with no conversation picked — no
    // observer should be created against nothing to observe.
    expect(ctorSpy).not.toHaveBeenCalled();

    rerender(
      <WebAppStoreContext.Provider value={store}>
        <ChatView conversationId={CONVERSATION_ID} gatewayLabel="acme" />
      </WebAppStoreContext.Provider>,
    );

    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].open();
    await waitFor(() => expect(store.getState().connection).toBe('connected'));

    await waitFor(() => expect(ctorSpy).toHaveBeenCalledTimes(1));
    const sentinel = screen.getByTestId('chat-transcript-sentinel');
    expect(observeSpy).toHaveBeenCalledWith(sentinel);

    vi.unstubAllGlobals();
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

describe('ChatView empty-chat greeting (chat-ux Phase 3 Task 4, audit #13 remainder)', () => {
  it('shows the greeting and starter prompts once a conversation with no history finishes loading', async () => {
    await renderConnected();

    const empty = screen.getByTestId('chat-empty-state');
    expect(within(empty).getByText(EMPTY_CHAT_GREETING)).toBeTruthy();
    for (const prompt of STARTER_PROMPTS) {
      expect(within(empty).getByText(prompt)).toBeTruthy();
    }
  });

  it('does not show the greeting while the initial history replay is still in flight — only ' +
    'once it resolves empty', async () => {
    let resolveMessages!: (page: {
      items: ConversationMessage[];
      nextCursor: null;
      throughSeq: number;
    }) => void;
    const pending = new Promise<{
      items: ConversationMessage[];
      nextCursor: null;
      throughSeq: number;
    }>((resolve) => {
      resolveMessages = resolve;
    });
    const rest = {
      listConversations: vi.fn(async () => ({ items: [summary()], nextCursor: null })),
      getMessages: vi.fn(() => pending),
    } as unknown as MobileRestClient;
    const { factory } = scriptedSocketFactory();
    const store = createWebAppStore({ rest, socketFactory: factory });
    await store.getState().loadConversations();

    render(
      <WebAppStoreContext.Provider value={store}>
        <ChatView conversationId={CONVERSATION_ID} gatewayLabel="acme" />
      </WebAppStoreContext.Provider>,
    );

    expect(screen.queryByTestId('chat-empty-state')).toBeNull();

    await act(async () => {
      resolveMessages({ items: [], nextCursor: null, throughSeq: 0 });
      await pending;
    });

    await waitFor(() => expect(screen.getByTestId('chat-empty-state')).toBeTruthy());
  });

  it('clicking a starter prompt prefills the composer without sending', async () => {
    const { sockets } = await renderConnected();

    fireEvent.click(screen.getByText(STARTER_PROMPTS[0]));

    const textarea = screen.getByLabelText('Message') as HTMLTextAreaElement;
    expect(textarea.value).toBe(STARTER_PROMPTS[0]);
    expect(sockets[0].sent).toHaveLength(0);
  });

  it('hides the greeting once the conversation has a message', async () => {
    await renderConnected({
      messages: [message({ content: { type: 'user', text: 'Ping' } })],
    });

    expect(screen.queryByTestId('chat-empty-state')).toBeNull();
  });

  it('hides the greeting once a turn starts streaming, even with zero confirmed messages', async () => {
    const { sockets, onFrames } = await renderConnected();

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    // A brand-new optimistic user message already makes `messages.length`
    // nonzero here, but assert the greeting is gone regardless — belt and
    // suspenders against a future change to how the optimistic send works.
    expect(screen.queryByTestId('chat-empty-state')).toBeNull();

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
    expect(screen.queryByTestId('chat-empty-state')).toBeNull();
  });
});

describe('ChatView message actions (chat-ux Phase 2 Task 4, audit #5)', () => {
  it('shows Copy and Edit & resend, but not Retry, on a user message whose turn did not fail', async () => {
    await renderConnected({
      messages: [message({ id: 'u1', turnId: 'turn-1', content: { type: 'user', text: 'Ping' } })],
    });

    expect(screen.getByLabelText('Edit and resend this message')).toBeTruthy();
    expect(screen.queryByLabelText('Retry sending this message')).toBeNull();
  });

  it('shows Retry on a user message whose own status is failed', async () => {
    await renderConnected({
      messages: [
        message({
          id: 'u1',
          turnId: 'turn-1',
          status: 'failed',
          content: { type: 'user', text: 'Ping' },
        }),
      ],
    });

    expect(screen.getByLabelText('Retry sending this message')).toBeTruthy();
  });

  it("shows Retry on a user message whose turn's ASSISTANT reply failed server-side (the user message's own status is untouched)", async () => {
    await renderConnected({
      messages: [
        message({
          id: 'u1',
          turnId: 'turn-1',
          ordinal: 1,
          content: { type: 'user', text: 'Ping' },
        }),
        message({
          id: 'a1',
          turnId: 'turn-1',
          ordinal: 2,
          role: 'assistant',
          status: 'failed',
          content: { type: 'assistant', events: [] },
        }),
      ],
    });

    expect(screen.getByLabelText('Retry sending this message')).toBeTruthy();
  });

  it('does not offer Edit & resend or Retry on an assistant message', async () => {
    await renderConnected({
      messages: [
        message({
          id: 'a1',
          turnId: 'turn-1',
          role: 'assistant',
          status: 'failed',
          content: { type: 'assistant', events: [{ type: 'text_delta', text: 'Oops' }] },
        }),
      ],
    });

    expect(screen.queryByLabelText('Edit and resend this message')).toBeNull();
    expect(screen.queryByLabelText('Retry sending this message')).toBeNull();
  });

  it('Retry re-sends the failed message text through a fresh send', async () => {
    const { sockets } = await renderConnected({
      messages: [
        message({
          id: 'u1',
          turnId: 'turn-1',
          status: 'failed',
          content: { type: 'user', text: 'Retry me' },
        }),
      ],
    });

    fireEvent.click(screen.getByLabelText('Retry sending this message'));

    await waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    expect(sockets[0].sent[0]).toMatchObject({ type: 'message', text: 'Retry me' });
    // The failed message is gone, replaced by the fresh optimistic send.
    await waitFor(() => expect(screen.queryByText('Failed to send')).toBeNull());
  });

  it('Edit & resend swaps the bubble to a prefilled textarea; Enter resends the edited text', async () => {
    const { sockets } = await renderConnected({
      messages: [
        message({ id: 'u1', turnId: 'turn-1', content: { type: 'user', text: 'Original' } }),
      ],
    });

    fireEvent.click(screen.getByLabelText('Edit and resend this message'));

    const editor = screen.getByLabelText('Edit message') as HTMLTextAreaElement;
    expect(editor.value).toBe('Original');

    fireEvent.change(editor, { target: { value: 'Edited version' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    expect(sockets[0].sent[0]).toMatchObject({ type: 'message', text: 'Edited version' });
  });

  it('Edit & resend: Shift+Enter does not submit, Escape cancels back to the rendered bubble', async () => {
    const { sockets } = await renderConnected({
      messages: [
        message({ id: 'u1', turnId: 'turn-1', content: { type: 'user', text: 'Original' } }),
      ],
    });

    fireEvent.click(screen.getByLabelText('Edit and resend this message'));
    const editor = screen.getByLabelText('Edit message') as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: 'Original\nmore' } });
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });
    expect(sockets[0].sent).toHaveLength(0);

    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByLabelText('Edit message')).toBeNull();
    expect(screen.getByText('Original')).toBeTruthy();
    expect(sockets[0].sent).toHaveLength(0);
  });

  it('Edit & resend: the Resend button is disabled for empty/whitespace-only text', async () => {
    await renderConnected({
      messages: [
        message({ id: 'u1', turnId: 'turn-1', content: { type: 'user', text: 'Original' } }),
      ],
    });

    fireEvent.click(screen.getByLabelText('Edit and resend this message'));
    const editor = screen.getByLabelText('Edit message') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '   ' } });

    expect(screen.getByText('Resend')).toHaveProperty('disabled', true);
  });

  it('fix I5: a blocked resend (a later turn is already streaming when the edit is submitted) ' +
    'keeps the editor open with the edited text intact and shows an inline note, instead of ' +
    'closing unconditionally and silently discarding what the user typed', async () => {
    const { store } = await renderConnected({
      messages: [
        message({ id: 'u1', turnId: 'turn-1', content: { type: 'user', text: 'Original' } }),
      ],
    });

    fireEvent.click(screen.getByLabelText('Edit and resend this message'));
    const editor = screen.getByLabelText('Edit message') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'Unsent edited text' } });

    // A later turn starts streaming while the editor is still open — an
    // already-open editor bypasses the toolbar's own `canAct` gate (see
    // the OTHER regression test above), so `resendFromMessage`'s own
    // in-flight guard is what's actually being exercised here, not the
    // toolbar's visibility.
    act(() => {
      store.setState((state) => ({
        transcripts: {
          ...state.transcripts,
          [CONVERSATION_ID]: {
            ...state.transcripts[CONVERSATION_ID],
            streaming: { type: 'assistant', events: [] },
          },
        },
      }));
    });

    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText(RESEND_BLOCKED_COPY)).toBeTruthy());
    // Still open, with the user's text intact — not silently discarded.
    const stillOpenEditor = screen.getByLabelText('Edit message') as HTMLTextAreaElement;
    expect(stillOpenEditor.value).toBe('Unsent edited text');
    // Nothing was truncated or sent.
    expect(store.getState().transcripts[CONVERSATION_ID]?.messages).toHaveLength(1);
  });

  it('regression: Retry/Edit & resend on an EARLIER failed message are removed from the DOM ' +
    'while a LATER turn is actively streaming, and come back once it finishes — activating ' +
    "either mid-stream would truncate the in-flight turn's own optimistic message out from " +
    'under it and fire a second, orphaned send (canAct = canSend && !isStreaming)', async () => {
    const { sockets, onFrames } = await renderConnected({
      messages: [
        message({
          id: 'u1',
          turnId: 'turn-1',
          ordinal: 1,
          status: 'failed',
          content: { type: 'user', text: 'Earlier failed message' },
        }),
      ],
    });

    // Buttons are present (and inactive) before any later turn starts.
    expect(screen.getByLabelText('Retry sending this message')).toBeTruthy();
    expect(screen.getByLabelText('Edit and resend this message')).toBeTruthy();

    // Start a new, later turn — this is what used to leave the earlier
    // message's buttons real/focusable (opacity: 0 but in the DOM and
    // reachable via :focus-within) throughout the whole stream.
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'newer message' } });
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

    await waitFor(() => expect(screen.queryByLabelText('Retry sending this message')).toBeNull());
    expect(screen.queryByLabelText('Edit and resend this message')).toBeNull();

    // A stray click can't reach a button that isn't rendered — the
    // regression this guards against.
    expect(sockets[0].sent).toHaveLength(1);

    act(() => {
      onFrames[0]({
        type: 'done',
        id: turnId,
        conversationId: CONVERSATION_ID,
        seq: 2,
        outcome: 'completed',
      });
    });

    await waitFor(() => expect(screen.getByLabelText('Retry sending this message')).toBeTruthy());
    // Both the earlier (failed) message and the now-completed newer one
    // are user messages with `canAct` true again, so `getAllBy` (not
    // `getBy`) — only 'Retry' stays unique to the failed one.
    expect(screen.getAllByLabelText('Edit and resend this message').length).toBe(2);
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

    // Baseline captured AFTER the turn has started, not before: accepting
    // a turn flips `isStreaming` (and so every row's `canAct` prop —
    // chat-ux Phase 2 Task 4 fix wave, audit #5 mid-stream-resend
    // regression) for the WHOLE conversation, which is a real, one-time
    // prop change on the confirmed 'Ping' row too — memo correctly lets
    // that one through. What this test actually guards is that further
    // per-TOKEN `event` frames (below) don't cause additional re-renders
    // of unrelated confirmed rows once `isStreaming` has already settled.
    const before = confirmedMessageRenderCount();

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
