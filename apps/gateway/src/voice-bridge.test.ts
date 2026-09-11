import type { AgentEvent } from '@dash/agent';
import type { MobileWsServerFrame } from '@dash/mobile-contract';
import { SpeechError, type SpeechService } from '@dash/speech';
import { describe, expect, it, vi } from 'vitest';
import type { ResumableChatHub, TurnFrameSink } from './resumable-chat-hub.js';
import { createVoiceTurnBridge, withTranscriptionDeadline } from './voice-bridge.js';

function fakeSpeech(overrides: Partial<SpeechService> = {}): SpeechService {
  return {
    currentConfig: vi.fn(),
    providers: vi.fn(),
    listModels: vi.fn(),
    transcribe: vi.fn(),
    speechFormat: vi.fn(),
    synthesize: vi.fn(),
    available: vi.fn().mockResolvedValue(true),
    invalidate: vi.fn(),
    ...overrides,
  } as unknown as SpeechService;
}

describe('withTranscriptionDeadline', () => {
  it('passes a transcription that resolves in time straight through', async () => {
    const transcribe = vi.fn().mockResolvedValue({ text: 'hello' });
    const speech = withTranscriptionDeadline(fakeSpeech({ transcribe }), 20_000);

    await expect(speech.transcribe(new Uint8Array([1]), 'wav', 'en')).resolves.toEqual({
      text: 'hello',
    });
    expect(transcribe).toHaveBeenCalledWith(new Uint8Array([1]), 'wav', 'en');
  });

  it('rejects with a network SpeechError once the deadline elapses', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const speech = withTranscriptionDeadline(
        fakeSpeech({ transcribe: vi.fn().mockReturnValue(new Promise(() => {})) }),
        20_000,
      );
      const pending = speech.transcribe(new Uint8Array([1]), 'wav');
      const assertion = expect(pending).rejects.toMatchObject({
        name: 'SpeechError',
        code: 'network',
        message: 'transcription timed out',
      });
      vi.advanceTimersByTime(20_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a provider failure unchanged and delegates every other method', async () => {
    const failure = new SpeechError('provider', 'stt exploded');
    const inner = fakeSpeech({
      transcribe: vi.fn().mockRejectedValue(failure),
      available: vi.fn().mockResolvedValue(false),
    });
    const speech = withTranscriptionDeadline(inner, 20_000);

    await expect(speech.transcribe(new Uint8Array([1]), 'wav')).rejects.toBe(failure);
    await expect(speech.available()).resolves.toBe(false);
    speech.invalidate();
    expect(inner.invalidate).toHaveBeenCalledOnce();
  });
});

function makeBridgeHarness(options: { startThrows?: unknown } = {}) {
  const forwarded: MobileWsServerFrame[] = [];
  const start = vi.fn<ResumableChatHub['start']>(() => {
    if (options.startThrows !== undefined) throw options.startThrows;
  });
  const answer = vi.fn<ResumableChatHub['answer']>().mockResolvedValue(undefined);
  const cancel = vi.fn<ResumableChatHub['cancel']>().mockResolvedValue(undefined);
  const unsubscribe = vi.fn<ResumableChatHub['unsubscribe']>();
  const hub = { start, answer, cancel, unsubscribe } as unknown as ResumableChatHub;
  const bridge = createVoiceTurnBridge({
    hub,
    agentId: 'agent-01',
    conversationId: 'conversation-01',
    forward: (frame) => {
      forwarded.push(frame);
    },
    errorFrame: (id, conversationId, error) => ({
      type: 'error',
      id,
      conversationId,
      error: error instanceof Error ? error.message : String(error),
      code: 'not_found',
      retryable: false,
    }),
  });
  const events: AgentEvent[] = [];
  const done: { outcome: string; error?: string }[] = [];
  const startTurn = (turnId: string, text = 'hi'): void => {
    bridge.driver.start(
      turnId,
      text,
      (event) => events.push(event),
      (outcome, error) => done.push({ outcome, ...(error === undefined ? {} : { error }) }),
    );
  };
  return { bridge, hub, start, answer, cancel, unsubscribe, forwarded, events, done, startTurn };
}

describe('createVoiceTurnBridge', () => {
  it('starts a resumable voice turn on the hub with its own sink', () => {
    const h = makeBridgeHarness();
    h.startTurn('turn-01', 'what is the weather');

    expect(h.start).toHaveBeenCalledOnce();
    expect(h.start.mock.calls[0]?.[0]).toEqual({
      type: 'message',
      id: 'turn-01',
      agentId: 'agent-01',
      channelId: 'ios',
      conversationId: 'conversation-01',
      text: 'what is the weather',
      resumable: true,
      modality: 'voice',
    });
    expect(h.start.mock.calls[0]?.[1]).toBe(h.bridge.sink);
  });

  it('drops the conversation subscription starting a turn takes out', () => {
    const h = makeBridgeHarness();
    h.startTurn('turn-01');

    // Otherwise a notification turn on this conversation would reach the
    // socket twice: once through this sink, once through the connection's.
    expect(h.unsubscribe).toHaveBeenCalledWith('agent-01', 'conversation-01', h.bridge.sink);
  });

  it('drops the subscription even when the hub refuses the turn', () => {
    const h = makeBridgeHarness({ startThrows: new Error('nope') });
    h.startTurn('turn-01');

    expect(h.unsubscribe).toHaveBeenCalledWith('agent-01', 'conversation-01', h.bridge.sink);
  });

  it('forwards every hub frame and routes the running turn to the driver callbacks', () => {
    const h = makeBridgeHarness();
    h.startTurn('turn-01');
    const sink: TurnFrameSink = h.bridge.sink;

    sink.send({
      type: 'accepted',
      id: 'turn-01',
      conversationId: 'conversation-01',
      userMessageId: 'u',
      assistantMessageId: 'a',
      revision: 1,
      seq: 1,
    });
    sink.send({ type: 'event', id: 'turn-01', event: { type: 'text_delta', text: 'hi' } });
    sink.send({ type: 'event', id: 'turn-99', event: { type: 'text_delta', text: 'other' } });
    sink.send({ type: 'done', id: 'turn-01', outcome: 'completed' });

    expect(h.forwarded.map((frame) => frame.type)).toEqual(['accepted', 'event', 'event', 'done']);
    expect(h.events).toEqual([{ type: 'text_delta', text: 'hi' }]);
    expect(h.done).toEqual([{ outcome: 'completed' }]);
  });

  it('reports a cancelled done and an error frame as the turn outcome', () => {
    const cancelled = makeBridgeHarness();
    cancelled.startTurn('turn-01');
    cancelled.bridge.sink.send({ type: 'done', id: 'turn-01', outcome: 'cancelled' });
    expect(cancelled.done).toEqual([{ outcome: 'cancelled' }]);

    const failed = makeBridgeHarness();
    failed.startTurn('turn-02');
    failed.bridge.sink.send({ type: 'error', id: 'turn-02', error: 'boom' });
    expect(failed.done).toEqual([{ outcome: 'failed', error: 'boom' }]);
  });

  it('turns a hub throw into a forwarded error frame and a failed turn', async () => {
    const h = makeBridgeHarness({ startThrows: new Error('Conversation not found') });
    expect(() => h.startTurn('turn-01')).not.toThrow();
    // Deferred: the session finishes starting its turn before the failure lands.
    expect(h.done).toEqual([]);

    await Promise.resolve();
    expect(h.forwarded).toEqual([
      {
        type: 'error',
        id: 'turn-01',
        conversationId: 'conversation-01',
        error: 'Conversation not found',
        code: 'not_found',
        retryable: false,
      },
    ]);
    expect(h.done).toEqual([{ outcome: 'failed', error: 'Conversation not found' }]);
  });

  it('routes answers and cancels to the hub', async () => {
    const h = makeBridgeHarness();
    h.startTurn('turn-01');

    await h.bridge.driver.answer('turn-01', 'question-01', 'yes');
    await h.bridge.driver.cancel('turn-01');

    expect(h.answer).toHaveBeenCalledWith('turn-01', 'question-01', 'yes');
    expect(h.cancel).toHaveBeenCalledWith('turn-01', h.bridge.sink);
  });
});
