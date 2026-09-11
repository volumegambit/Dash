import { DEFAULT_SPEECH_CONFIG, type SpeechConfig } from './config.js';
import { SpeechError } from './errors.js';
import { type VoiceServerFrame, VoiceSession } from './session.js';
import { SpokenRenderer } from './spoken-renderer.js';
import { silence, tone } from './test-audio.js';
import { FakeSpeechService, FakeTurnDriver } from './test-doubles.js';
import { VoiceActivityDetector } from './vad.js';

const BYTES_PER_MS = 32; // 16 kHz, mono, 16-bit PCM
const FRAME_MS = 20;

/** Splits `pcm` into 20ms frames, the way the phone streams it. */
function framesOf(pcm: Uint8Array): Uint8Array[] {
  const frameBytes = FRAME_MS * BYTES_PER_MS;
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    out.push(pcm.subarray(offset, offset + frameBytes));
  }
  return out;
}

function feed(session: VoiceSession, pcm: Uint8Array): void {
  for (const frame of framesOf(pcm)) session.audio(frame);
}

/** Loud enough to clear the VAD threshold; long enough to confirm at startMs 400. */
function utterance(toneMs = 800, trailingSilenceMs = 800): Uint8Array {
  return new Uint8Array([...tone(toneMs, 440, 0.5), ...silence(trailingSilenceMs)]);
}

/** Lets every pending microtask/`setImmediate` continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

const CONFIG: SpeechConfig = {
  ...DEFAULT_SPEECH_CONFIG,
  stt: { ...DEFAULT_SPEECH_CONFIG.stt, language: 'de' },
};

interface Harness {
  session: VoiceSession;
  speech: FakeSpeechService;
  driver: FakeTurnDriver;
  vad: VoiceActivityDetector;
  frames: VoiceServerFrame[];
  timeline: string[];
  now(): number;
  setNow(ms: number): void;
  advance(ms: number): void;
}

function harness(
  options: {
    format?: 'pcm16' | 'mp3';
    sampleRate?: number;
    config?: SpeechConfig;
    renderer?: () => SpokenRenderer;
  } = {},
): Harness {
  let clock = 10_000;
  const frames: VoiceServerFrame[] = [];
  const timeline: string[] = [];

  const speech = new FakeSpeechService({
    config: options.config ?? CONFIG,
    format: options.format ?? 'mp3',
    sampleRate: options.sampleRate,
  });
  const driver = new FakeTurnDriver((call) => timeline.push(`driver:${call}`));
  // calibrationMs: 0 — these tests drive the detector directly and must not
  // lose the first 500ms of every clip to the noise-floor calibration window.
  const vad = new VoiceActivityDetector({ calibrationMs: 0 });

  const session = new VoiceSession({
    id: 'sess-1',
    speech,
    driver,
    vad,
    now: () => clock,
    newTurnId: () => `turn-${driver.starts.length + 1}`,
    ...(options.renderer ? { renderer: options.renderer } : {}),
    emit: (frame) => {
      frames.push(frame);
      timeline.push(`frame:${frame.type}`);
    },
  });

  return {
    session,
    speech,
    driver,
    vad,
    frames,
    timeline,
    now: () => clock,
    setNow: (ms) => {
      clock = ms;
    },
    advance: (ms) => {
      clock += ms;
    },
  };
}

function states(frames: VoiceServerFrame[]): string[] {
  return frames.filter((f) => f.type === 'voice_state').map((f) => f.state);
}

function speechFrames(frames: VoiceServerFrame[]) {
  return frames.filter((f) => f.type === 'voice_speech');
}

function transcripts(frames: VoiceServerFrame[]) {
  return frames.filter((f) => f.type === 'voice_transcript');
}

/** Drives one utterance through the VAD and resolves its transcription as `text`. */
async function say(h: Harness, text: string): Promise<void> {
  feed(h.session, utterance());
  await settle();
  const pending = h.speech.transcribes.at(-1);
  if (!pending) throw new Error('no pending transcription');
  pending.resolve(text);
  await settle();
}

describe('VoiceSession', () => {
  it('starts listening and announces it', () => {
    const h = harness();
    expect(h.session.state).toBe('listening');
    expect(h.frames).toEqual([{ type: 'voice_state', id: 'sess-1', state: 'listening' }]);
  });

  it('runs a full turn: transcript before driver.start, then speech, then back to listening', async () => {
    const h = harness();

    feed(h.session, utterance());
    await settle();

    expect(h.session.state).toBe('transcribing');
    expect(states(h.frames)).toEqual(['listening', 'transcribing']);

    const pending = h.speech.transcribes[0];
    expect(pending.format).toBe('wav');
    expect(new TextDecoder().decode(pending.audio.subarray(0, 4))).toBe('RIFF');
    expect(pending.language).toBe('de');

    pending.resolve('what is the weather');
    await settle();

    // The transcript frame that starts the turn carries the turnId and MUST
    // precede driver.start — B9 keys its optimistic row on it.
    expect(h.timeline.slice(-3)).toEqual([
      'frame:voice_transcript',
      'driver:start',
      'frame:voice_state',
    ]);
    expect(transcripts(h.frames)).toEqual([
      {
        type: 'voice_transcript',
        id: 'sess-1',
        text: 'what is the weather',
        final: true,
        turnId: 'turn-1',
      },
    ]);
    expect(h.driver.starts).toEqual([{ turnId: 'turn-1', text: 'what is the weather' }]);
    expect(h.session.state).toBe('thinking');

    h.driver.event('turn-1', { type: 'text_delta', text: 'It is sunny. ' });
    await settle();

    expect(h.speech.syntheses.map((s) => s.text)).toEqual(['It is sunny.']);
    const stream = h.speech.syntheses[0];
    stream.push(new Uint8Array([1, 2, 3]));
    stream.push(new Uint8Array([4]));
    await settle();

    // MP3 is collected per sentence: nothing is emitted until the stream ends.
    expect(speechFrames(h.frames)).toHaveLength(0);
    stream.end();
    await settle();

    expect(h.session.state).toBe('speaking');
    expect(speechFrames(h.frames)).toEqual([
      {
        type: 'voice_speech',
        id: 'sess-1',
        seq: 0,
        audio: Buffer.from([1, 2, 3, 4]).toString('base64'),
        format: 'mp3',
        text: 'It is sunny.',
      },
    ]);
    // The state flip is announced BEFORE the first audio frame.
    expect(h.timeline.slice(-2)).toEqual(['frame:voice_state', 'frame:voice_speech']);

    h.driver.done('turn-1', 'completed');
    await settle();

    expect(states(h.frames)).toEqual([
      'listening',
      'transcribing',
      'thinking',
      'speaking',
      'listening',
    ]);
    expect(h.session.state).toBe('listening');
  });

  it('emits one voice_speech per provider chunk for pcm16, with the sample rate', async () => {
    const h = harness({ format: 'pcm16', sampleRate: 24_000 });
    await say(h, 'hello');

    h.driver.event('turn-1', { type: 'text_delta', text: 'One. Two. ' });
    await settle();

    const first = h.speech.syntheses[0];
    first.push(new Uint8Array([1, 1]));
    await settle();
    first.push(new Uint8Array([2, 2]));
    first.end();
    await settle();

    const second = h.speech.syntheses[1];
    second.push(new Uint8Array([3, 3]));
    second.end();
    await settle();

    expect(speechFrames(h.frames)).toEqual([
      {
        type: 'voice_speech',
        id: 'sess-1',
        seq: 0,
        audio: Buffer.from([1, 1]).toString('base64'),
        format: 'pcm16',
        sampleRate: 24_000,
        text: 'One.',
      },
      {
        type: 'voice_speech',
        id: 'sess-1',
        seq: 1,
        audio: Buffer.from([2, 2]).toString('base64'),
        format: 'pcm16',
        sampleRate: 24_000,
        text: 'One.',
      },
      {
        type: 'voice_speech',
        id: 'sess-1',
        seq: 2,
        audio: Buffer.from([3, 3]).toString('base64'),
        format: 'pcm16',
        sampleRate: 24_000,
        text: 'Two.',
      },
    ]);
  });

  it('serializes synthesis: the second item is not requested until the first stream ends', async () => {
    const h = harness();
    await say(h, 'hello');

    h.driver.event('turn-1', { type: 'text_delta', text: 'One. Two. Three. ' });
    await settle();

    expect(h.speech.syntheses.map((s) => s.text)).toEqual(['One.']);
    h.speech.syntheses[0].end();
    await settle();
    expect(h.speech.syntheses.map((s) => s.text)).toEqual(['One.', 'Two.']);
    h.speech.syntheses[1].end();
    await settle();
    expect(h.speech.syntheses.map((s) => s.text)).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('speaks a tool status phrase like any other item', async () => {
    const h = harness();
    await say(h, 'read the file');

    h.driver.event('turn-1', { type: 'tool_use_start', id: 't1', name: 'Read' });
    await settle();

    expect(h.speech.syntheses.map((s) => s.text)).toEqual(['Looking at the files.']);
  });

  it('flushes a trailing partial sentence when the turn completes', async () => {
    const h = harness();
    await say(h, 'hello');

    h.driver.event('turn-1', { type: 'text_delta', text: 'no terminator here' });
    await settle();
    expect(h.speech.syntheses).toHaveLength(0);

    h.driver.done('turn-1', 'completed');
    await settle();

    expect(h.speech.syntheses.map((s) => s.text)).toEqual(['no terminator here']);
    expect(h.session.state).toBe('thinking');

    h.speech.syntheses[0].push(new Uint8Array([9]));
    h.speech.syntheses[0].end();
    await settle();

    expect(h.session.state).toBe('listening');
  });

  it('drops a blank transcript without starting a turn', async () => {
    const h = harness();
    feed(h.session, utterance());
    await settle();
    h.speech.transcribes[0].resolve('   ');
    await settle();

    expect(h.driver.starts).toHaveLength(0);
    expect(transcripts(h.frames)).toHaveLength(0);
    expect(states(h.frames)).toEqual(['listening', 'transcribing', 'listening']);
    expect(h.session.state).toBe('listening');
  });

  it('reports a transcription SpeechError and returns to listening', async () => {
    const h = harness();
    feed(h.session, utterance());
    await settle();
    h.speech.transcribes[0].reject(new SpeechError('too_large', 'audio too large'));
    await settle();

    expect(h.frames.at(-2)).toEqual({
      type: 'voice_error',
      id: 'sess-1',
      code: 'too_large',
      error: 'audio too large',
    });
    expect(h.frames.at(-1)).toEqual({ type: 'voice_state', id: 'sess-1', state: 'listening' });
    expect(h.session.state).toBe('listening');
  });

  it('wraps a non-SpeechError transcription failure as a provider error', async () => {
    const h = harness();
    feed(h.session, utterance());
    await settle();
    h.speech.transcribes[0].reject(new Error('socket hang up'));
    await settle();

    expect(h.frames.at(-2)).toMatchObject({ type: 'voice_error', code: 'provider' });
    expect(h.session.state).toBe('listening');
  });

  it('stops the session when synthesis fails', async () => {
    const h = harness();
    h.speech.failSynthesizeWith = new SpeechError('unauthorized', 'bad key');
    await say(h, 'hello');

    h.driver.event('turn-1', { type: 'text_delta', text: 'It is sunny. ' });
    await settle();

    expect(h.frames.at(-2)).toEqual({
      type: 'voice_error',
      id: 'sess-1',
      code: 'unauthorized',
      error: 'bad key',
    });
    expect(h.frames.at(-1)).toEqual({
      type: 'voice_stopped',
      id: 'sess-1',
      reason: 'provider',
    });
    expect(h.session.state).toBe('stopped');
    expect(h.driver.cancels).toEqual(['turn-1']);

    // Everything afterwards is ignored.
    const count = h.frames.length;
    feed(h.session, utterance());
    await settle();
    expect(h.frames).toHaveLength(count);
    expect(h.speech.transcribes).toHaveLength(1);
  });

  it('drops audio while muted and restores the previous state on unmute', async () => {
    const h = harness();
    h.session.mute(true);

    expect(h.session.state).toBe('muted');
    expect(h.frames.at(-1)).toEqual({ type: 'voice_state', id: 'sess-1', state: 'muted' });

    feed(h.session, utterance());
    await settle();
    expect(h.speech.transcribes).toHaveLength(0);

    h.session.mute(false);
    expect(h.session.state).toBe('listening');
    expect(h.frames.at(-1)).toEqual({ type: 'voice_state', id: 'sess-1', state: 'listening' });

    // Idempotent both ways.
    const count = h.frames.length;
    h.session.mute(false);
    expect(h.frames).toHaveLength(count);
  });

  it('keeps playing while muted and unmutes back into speaking', async () => {
    const h = harness();
    await say(h, 'hello');
    h.driver.event('turn-1', { type: 'text_delta', text: 'It is sunny. ' });
    await settle();

    h.session.mute(true);
    expect(h.session.state).toBe('muted');

    h.speech.syntheses[0].push(new Uint8Array([7]));
    h.speech.syntheses[0].end();
    await settle();

    expect(speechFrames(h.frames)).toHaveLength(1);
    // No `speaking` state frame while muted — the client is showing "muted".
    expect(states(h.frames)).toEqual(['listening', 'transcribing', 'thinking', 'muted']);

    h.session.mute(false);
    expect(h.session.state).toBe('speaking');
    expect(h.frames.at(-1)).toEqual({
      type: 'voice_state',
      id: 'sess-1',
      state: 'speaking',
      turnId: 'turn-1',
    });
  });

  it('widens the VAD start window while speaking and restores it when listening', async () => {
    const h = harness();
    const setStartMs = vi.spyOn(h.vad, 'setStartMs');
    await say(h, 'hello');

    h.driver.event('turn-1', { type: 'text_delta', text: 'Sunny. ' });
    await settle();
    h.speech.syntheses[0].push(new Uint8Array([1]));
    h.speech.syntheses[0].end();
    await settle();
    expect(setStartMs).toHaveBeenLastCalledWith(400);

    h.driver.done('turn-1', 'completed');
    await settle();
    expect(setStartMs).toHaveBeenLastCalledWith(300);
  });

  it('ignores a barge-in within 300ms of the first spoken audio', async () => {
    const h = harness();
    await say(h, 'hello');
    h.driver.event('turn-1', { type: 'text_delta', text: 'One. Two. ' });
    await settle();

    // The first sentence's MP3 frame is what flips the session to `speaking`.
    h.speech.syntheses[0].push(new Uint8Array([1]));
    h.speech.syntheses[0].end();
    await settle();
    expect(h.session.state).toBe('speaking');

    const second = h.speech.syntheses[1];
    const speakingSince = h.now();

    h.setNow(speakingSince + 299);
    feed(h.session, tone(600, 440, 0.5));
    await settle();

    expect(h.driver.cancels).toEqual([]);
    expect(second.returned).toBe(false);
    expect(h.session.state).toBe('speaking');
    expect(states(h.frames).at(-1)).toBe('speaking');
  });

  it('barges in after the guard: aborts speech, clears the queue, cancels the turn', async () => {
    const h = harness();
    await say(h, 'hello');
    h.driver.event('turn-1', { type: 'text_delta', text: 'One. Two. ' });
    await settle();

    h.speech.syntheses[0].push(new Uint8Array([1]));
    h.speech.syntheses[0].end();
    await settle();

    const second = h.speech.syntheses[1];
    const speakingSince = h.now();

    h.setNow(speakingSince + 300);
    feed(h.session, tone(600, 440, 0.5));
    await settle();

    expect(h.driver.cancels).toEqual(['turn-1']);
    expect(second.returned).toBe(true);
    expect(h.session.state).toBe('listening');
    expect(states(h.frames).at(-1)).toBe('listening');

    // Nothing more is synthesized, and a late onDone changes nothing.
    h.driver.done('turn-1', 'cancelled');
    await settle();
    expect(h.speech.syntheses).toHaveLength(2);
    expect(states(h.frames).at(-1)).toBe('listening');

    // The interrupting utterance is captured normally and becomes the next turn.
    feed(h.session, new Uint8Array([...tone(400, 440, 0.5), ...silence(800)]));
    await settle();
    expect(h.session.state).toBe('transcribing');
    h.speech.transcribes[1].resolve('stop, tell me a joke');
    await settle();

    expect(h.driver.starts).toEqual([
      { turnId: 'turn-1', text: 'hello' },
      { turnId: 'turn-2', text: 'stop, tell me a joke' },
    ]);
  });

  it('treats the next utterance as the answer to a pending question', async () => {
    const h = harness();
    await say(h, 'delete the file');

    h.driver.event('turn-1', {
      type: 'question',
      id: 'q1',
      question: 'Are you sure?',
      options: ['yes', 'no'],
    });
    await settle();

    expect(h.speech.syntheses.map((s) => s.text)).toEqual(['Are you sure? yes, or no?']);
    h.speech.syntheses[0].push(new Uint8Array([1]));
    h.speech.syntheses[0].end();
    await settle();

    // The turn is paused, not finished: the session listens for the answer.
    expect(h.session.state).toBe('listening');

    await say(h, 'yes please');

    expect(h.driver.answers).toEqual([
      { turnId: 'turn-1', questionId: 'q1', answer: 'yes please' },
    ]);
    expect(h.driver.starts).toHaveLength(1);
    expect(transcripts(h.frames).at(-1)).toEqual({
      type: 'voice_transcript',
      id: 'sess-1',
      text: 'yes please',
      final: true,
    });
    // The answer is transcribed like any other utterance.
    expect(states(h.frames).slice(-2)).toEqual(['transcribing', 'thinking']);
    expect(h.session.state).toBe('thinking');
  });

  it('drops a pending question when its turn ends, so the next utterance is a new turn', async () => {
    const h = harness();
    await say(h, 'delete the file');

    h.driver.event('turn-1', {
      type: 'question',
      id: 'q1',
      question: 'Are you sure?',
      options: [],
    });
    await settle();
    h.speech.syntheses[0].push(new Uint8Array([1]));
    h.speech.syntheses[0].end();
    await settle();
    expect(h.session.state).toBe('listening');

    // The turn dies before the user answers (hub timeout, agent abort, ...).
    h.driver.done('turn-1', 'cancelled');
    await settle();
    expect(h.session.state).toBe('listening');

    await say(h, 'hello again');

    expect(h.driver.answers).toEqual([]);
    expect(h.driver.starts).toEqual([
      { turnId: 'turn-1', text: 'delete the file' },
      { turnId: 'turn-2', text: 'hello again' },
    ]);
    expect(h.session.state).toBe('thinking');
  });

  it('queues an utterance spoken during a turn and starts it when the turn drains', async () => {
    const h = harness();
    await say(h, 'first question');

    // Still thinking — this utterance is not a barge-in, so it queues.
    feed(h.session, utterance());
    await settle();
    expect(h.session.state).toBe('thinking');
    h.speech.transcribes[1].resolve('second question');
    await settle();

    expect(h.driver.starts).toHaveLength(1);
    expect(transcripts(h.frames).at(-1)).toEqual({
      type: 'voice_transcript',
      id: 'sess-1',
      text: 'second question',
      final: true,
    });

    h.driver.event('turn-1', { type: 'text_delta', text: 'Answer one. ' });
    await settle();
    h.speech.syntheses[0].push(new Uint8Array([1]));
    h.speech.syntheses[0].end();
    h.driver.done('turn-1', 'completed');
    await settle();

    // The queued transcript is re-emitted WITH its turnId, then started.
    expect(transcripts(h.frames).at(-1)).toEqual({
      type: 'voice_transcript',
      id: 'sess-1',
      text: 'second question',
      final: true,
      turnId: 'turn-2',
    });
    expect(h.driver.starts).toEqual([
      { turnId: 'turn-1', text: 'first question' },
      { turnId: 'turn-2', text: 'second question' },
    ]);
    expect(h.session.state).toBe('thinking');
    expect(states(h.frames).filter((s) => s === 'listening')).toHaveLength(1);
  });

  it('stops mid-speech: cancels the turn, aborts the stream, ignores everything after', async () => {
    const h = harness();
    await say(h, 'hello');
    h.driver.event('turn-1', { type: 'text_delta', text: 'One. Two. ' });
    await settle();
    h.speech.syntheses[0].push(new Uint8Array([1]));
    h.speech.syntheses[0].end();
    await settle();
    expect(h.session.state).toBe('speaking');
    const second = h.speech.syntheses[1];

    h.session.stop('client');
    await settle();

    expect(h.frames.at(-1)).toEqual({ type: 'voice_stopped', id: 'sess-1', reason: 'client' });
    expect(h.driver.cancels).toEqual(['turn-1']);
    expect(second.returned).toBe(true);
    expect(h.session.state).toBe('stopped');

    const count = h.frames.length;
    h.session.stop('socket');
    h.session.mute(true);
    feed(h.session, utterance());
    h.driver.event('turn-1', { type: 'text_delta', text: 'Three. ' });
    h.driver.done('turn-1', 'cancelled');
    await settle();

    expect(h.frames).toHaveLength(count);
    expect(h.speech.syntheses).toHaveLength(2);
    expect(h.driver.cancels).toEqual(['turn-1']);
  });

  it('stops from listening without cancelling anything', async () => {
    const h = harness();
    h.session.stop('replaced');

    expect(h.frames.at(-1)).toEqual({ type: 'voice_stopped', id: 'sess-1', reason: 'replaced' });
    expect(h.driver.cancels).toEqual([]);
    expect(h.session.state).toBe('stopped');
  });

  it('never logs, and never puts audio or a transcript in a frame it should not', async () => {
    const h = harness();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => {}),
    );
    try {
      await say(h, 'hello there');
      h.driver.event('turn-1', { type: 'text_delta', text: 'Hi. ' });
      await settle();
      h.speech.syntheses[0].push(new Uint8Array([1]));
      h.speech.syntheses[0].end();
      h.driver.done('turn-1', 'completed');
      await settle();

      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
  it('fails the session when the driver throws instead of starting a turn', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const h = harness();
      h.driver.failStartWith = new Error('hub gone');

      feed(h.session, utterance());
      await settle();
      h.speech.transcribes[0].resolve('hello');
      await settle();

      expect(h.frames.at(-2)).toEqual({
        type: 'voice_error',
        id: 'sess-1',
        code: 'provider',
        error: 'hub gone',
      });
      expect(h.frames.at(-1)).toEqual({ type: 'voice_stopped', id: 'sess-1', reason: 'provider' });
      expect(h.session.state).toBe('stopped');

      await settle();
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('recovers when the driver rejects an answer instead of wedging the turn', async () => {
    const h = harness();
    await say(h, 'delete the file');

    h.driver.event('turn-1', { type: 'question', id: 'q1', question: 'Sure?', options: [] });
    await settle();
    h.speech.syntheses[0].push(new Uint8Array([1]));
    h.speech.syntheses[0].end();
    await settle();

    h.driver.failAnswerWith = new Error('hub gone');
    await say(h, 'yes');

    expect(h.frames.at(-2)).toMatchObject({ type: 'voice_error', code: 'provider' });
    expect(h.frames.at(-1)).toEqual({ type: 'voice_state', id: 'sess-1', state: 'listening' });
    expect(h.driver.cancels).toEqual(['turn-1']);

    // Not wedged: the next utterance is a new turn, not another answer.
    h.driver.failAnswerWith = undefined;
    await say(h, 'never mind');
    expect(h.driver.starts).toEqual([
      { turnId: 'turn-1', text: 'delete the file' },
      { turnId: 'turn-2', text: 'never mind' },
    ]);
  });

  it('serializes transcription and starts queued turns in utterance order', async () => {
    const h = harness();
    feed(h.session, utterance());
    feed(h.session, utterance());
    feed(h.session, utterance());
    await settle();

    // One transcription at a time: the second is not even requested until the
    // first resolves, which is what makes the turn order deterministic.
    expect(h.speech.transcribes).toHaveLength(1);
    h.speech.transcribes[0].resolve('one');
    await settle();
    expect(h.speech.transcribes).toHaveLength(2);
    h.speech.transcribes[1].resolve('two');
    await settle();
    expect(h.speech.transcribes).toHaveLength(3);
    h.speech.transcribes[2].resolve('three');
    await settle();

    expect(h.driver.starts).toEqual([{ turnId: 'turn-1', text: 'one' }]);

    h.driver.done('turn-1', 'completed');
    await settle();
    h.driver.done('turn-2', 'completed');
    await settle();

    expect(h.driver.starts).toEqual([
      { turnId: 'turn-1', text: 'one' },
      { turnId: 'turn-2', text: 'two' },
      { turnId: 'turn-3', text: 'three' },
    ]);
    // Every utterance eventually gets a transcript frame carrying its turnId.
    expect(
      transcripts(h.frames)
        .filter((t) => t.turnId !== undefined)
        .map((t) => [t.text, t.turnId]),
    ).toEqual([
      ['one', 'turn-1'],
      ['two', 'turn-2'],
      ['three', 'turn-3'],
    ]);
  });

  it('answers a pending question with a transcript queued while it was being spoken', async () => {
    const h = harness();
    await say(h, 'delete the file');

    h.driver.event('turn-1', { type: 'question', id: 'q1', question: 'Sure?', options: [] });
    await settle();

    // The user answers before the question has finished playing.
    feed(h.session, utterance());
    await settle();
    h.speech.transcribes[1].resolve('yes go ahead');
    await settle();
    expect(h.driver.answers).toEqual([]);

    h.speech.syntheses[0].push(new Uint8Array([1]));
    h.speech.syntheses[0].end();
    await settle();

    // Queued user speech is used as the answer, never silently dropped.
    expect(h.driver.answers).toEqual([
      { turnId: 'turn-1', questionId: 'q1', answer: 'yes go ahead' },
    ]);
    expect(h.driver.starts).toHaveLength(1);
    expect(h.session.state).toBe('thinking');
  });

  it('builds a fresh renderer per turn from the injected factory', async () => {
    let built = 0;
    const h = harness({
      renderer: () => {
        built++;
        return new SpokenRenderer({ now: h.now });
      },
    });

    await say(h, 'one');
    expect(built).toBe(1);
    h.driver.done('turn-1', 'completed');
    await settle();

    await say(h, 'two');
    expect(built).toBe(2);
  });

  it('reports a failed turn once its speech has drained', async () => {
    const h = harness();
    await say(h, 'hello');

    h.driver.event('turn-1', { type: 'text_delta', text: 'Half an answer. ' });
    await settle();
    h.speech.syntheses[0].push(new Uint8Array([1]));
    h.speech.syntheses[0].end();
    h.driver.done('turn-1', 'failed', 'model exploded');
    await settle();

    expect(h.frames.at(-2)).toEqual({
      type: 'voice_error',
      id: 'sess-1',
      code: 'provider',
      error: 'model exploded',
    });
    expect(h.frames.at(-1)).toEqual({ type: 'voice_state', id: 'sess-1', state: 'listening' });
  });

  it('survives a driver that throws instead of cancelling', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const h = harness();
      await say(h, 'hello');
      h.driver.failCancelWith = new Error('cancel exploded');

      expect(() => h.session.stop('client')).not.toThrow();
      expect(h.frames.at(-1)).toEqual({ type: 'voice_stopped', id: 'sess-1', reason: 'client' });
      expect(h.session.state).toBe('stopped');

      await settle();
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('discards a transcription that was in flight when the user barged in', async () => {
    const h = harness();
    await say(h, 'hello');
    h.driver.event('turn-1', { type: 'text_delta', text: 'One. Two. ' });
    await settle();
    h.speech.syntheses[0].push(new Uint8Array([1]));
    h.speech.syntheses[0].end();
    await settle();
    const speakingSince = h.now();

    // Spoken inside the guard: queued, and its transcription is still pending.
    feed(h.session, utterance());
    await settle();
    expect(h.speech.transcribes).toHaveLength(2);

    h.setNow(speakingSince + 400);
    feed(h.session, tone(600, 440, 0.5));
    await settle();
    expect(h.session.state).toBe('listening');

    // The stale transcription resolves after the barge-in: it must not become a turn.
    h.speech.transcribes[1].resolve('the reply I interrupted');
    await settle();

    expect(h.driver.starts).toEqual([{ turnId: 'turn-1', text: 'hello' }]);
    expect(transcripts(h.frames).map((t) => t.text)).toEqual(['hello']);
  });

  it('emits no audio after a barge-in even if the aborted stream yields again', async () => {
    const h = harness({ format: 'pcm16', sampleRate: 24_000 });
    await say(h, 'hello');
    h.driver.event('turn-1', { type: 'text_delta', text: 'One. Two. ' });
    await settle();

    const stream = h.speech.syntheses[0];
    stream.push(new Uint8Array([1, 1]));
    await settle();
    const speakingSince = h.now();

    h.setNow(speakingSince + 300);
    feed(h.session, tone(600, 440, 0.5));
    await settle();
    expect(states(h.frames).at(-1)).toBe('listening');

    stream.push(new Uint8Array([2, 2]));
    stream.end();
    await settle();

    const listeningAt = h.frames.findLastIndex(
      (f) => f.type === 'voice_state' && f.state === 'listening',
    );
    expect(h.frames.slice(listeningAt + 1).filter((f) => f.type === 'voice_speech')).toEqual([]);
  });

  it('stops the session when the synthesis stream fails mid-sentence', async () => {
    const h = harness();
    await say(h, 'hello');
    h.driver.event('turn-1', { type: 'text_delta', text: 'It is sunny. ' });
    await settle();

    h.speech.syntheses[0].push(new Uint8Array([1]));
    h.speech.syntheses[0].fail(new SpeechError('provider', 'stream died'));
    await settle();

    expect(h.frames.at(-2)).toEqual({
      type: 'voice_error',
      id: 'sess-1',
      code: 'provider',
      error: 'stream died',
    });
    expect(h.frames.at(-1)).toEqual({ type: 'voice_stopped', id: 'sess-1', reason: 'provider' });
    expect(h.session.state).toBe('stopped');
  });
});
