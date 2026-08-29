import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConversationMessage, MobileWsServerFrame } from '@dash/mobile-contract';
import { type Transcript, applyServerFrame } from './assemble';

// apps/web/src/state -> apps/web -> apps -> repo root
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURES_DIR = join(REPO_ROOT, 'contracts/mobile/v1/fixtures');

function readFixture<T>(file: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')) as T;
}

function readJsonl<T>(file: string): T[] {
  return readFileSync(join(FIXTURES_DIR, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function emptyTranscript(): Transcript {
  return { messages: [], streaming: null };
}

const accepted = readFixture<MobileWsServerFrame>('chat-accepted.json');
const event = readFixture<MobileWsServerFrame>('chat-event.json');
const done = readFixture<MobileWsServerFrame>('chat-done.json');
const error = readFixture<MobileWsServerFrame>('chat-error.json');
// The full happy-path turn: accepted -> event -> event -> event -> done.
// Real fixture, format: jsonl, schema: MobileWsServerFrame (Task 8's manifest).
const stream = readJsonl<MobileWsServerFrame>('chat-stream.jsonl');

describe('applyServerFrame', () => {
  describe('accepted', () => {
    it('opens a streaming assistant content and leaves messages untouched', () => {
      const t = applyServerFrame(emptyTranscript(), accepted);

      expect(t.streaming).toEqual({ type: 'assistant', events: [] });
      expect(t.messages).toEqual([]);
    });
  });

  describe('event', () => {
    it('grows streaming.events by one entry per event frame, in order', () => {
      let t = applyServerFrame(emptyTranscript(), accepted);
      t = applyServerFrame(t, event);

      expect(t.streaming).toEqual({
        type: 'assistant',
        events: [{ type: 'text_delta', text: 'Ready ' }],
      });
      expect(t.messages).toEqual([]);
    });

    it('appends each subsequent event to the end of the growing list', () => {
      let t = applyServerFrame(emptyTranscript(), accepted);
      for (const frame of stream.filter((f) => f.type === 'event')) {
        t = applyServerFrame(t, frame);
      }

      expect(t.streaming?.type).toBe('assistant');
      const events = t.streaming?.type === 'assistant' ? t.streaming.events : [];
      expect(events).toEqual([
        { type: 'text_delta', text: 'Ready ' },
        {
          type: 'question',
          id: 'question-01',
          question: 'Confirm mobile access?',
          options: ['Yes', 'No'],
        },
        {
          type: 'response',
          content: 'Ready from the gateway.',
          usage: { inputTokens: 12, outputTokens: 6 },
        },
      ]);
    });
  });

  describe('done', () => {
    it('finalizes the accumulated streaming content into a completed assistant message', () => {
      let t = emptyTranscript();
      for (const frame of stream) t = applyServerFrame(t, frame);

      expect(t.streaming).toBeNull();
      expect(t.messages).toHaveLength(1);
      const message = t.messages[0] as ConversationMessage;
      expect(message.id).toBe('018f0f4a-5c42-7a8b-9c01-4234567890ab'); // assistantMessageId
      expect(message.conversationId).toBe('018f0f4a-5c42-7a8b-9c01-1234567890ab');
      expect(message.role).toBe('assistant');
      expect(message.status).toBe('completed');
      expect(message.content).toEqual({
        type: 'assistant',
        events: [
          { type: 'text_delta', text: 'Ready ' },
          {
            type: 'question',
            id: 'question-01',
            question: 'Confirm mobile access?',
            options: ['Yes', 'No'],
          },
          {
            type: 'response',
            content: 'Ready from the gateway.',
            usage: { inputTokens: 12, outputTokens: 6 },
          },
        ],
      });
      expect(typeof message.createdAt).toBe('string');
      expect(Number.isNaN(Date.parse(message.createdAt))).toBe(false);
    });

    it('marks the finalized message cancelled when the turn outcome is cancelled', () => {
      const cancelledDone: MobileWsServerFrame = {
        type: 'done',
        id: accepted.type === 'accepted' ? accepted.id : '',
        conversationId: '018f0f4a-5c42-7a8b-9c01-1234567890ab',
        seq: 2,
        outcome: 'cancelled',
      };
      let t = applyServerFrame(emptyTranscript(), accepted);
      t = applyServerFrame(t, cancelledDone);

      expect(t.streaming).toBeNull();
      expect(t.messages).toHaveLength(1);
      expect(t.messages[0].status).toBe('cancelled');
      expect(t.messages[0].content).toEqual({ type: 'assistant', events: [] });
    });

    it('applied standalone (isolated fixture) finalizes from whatever streaming state exists', () => {
      let t = applyServerFrame(emptyTranscript(), accepted);
      t = applyServerFrame(t, event);
      t = applyServerFrame(t, done);

      expect(t.streaming).toBeNull();
      expect(t.messages).toHaveLength(1);
      expect(t.messages[0].status).toBe('completed');
    });
  });

  describe('error', () => {
    it('leaves the transcript intact (messages and streaming unchanged)', () => {
      let seeded = applyServerFrame(emptyTranscript(), accepted);
      seeded = applyServerFrame(seeded, event);

      const result = applyServerFrame(seeded, error);

      expect(result.messages).toEqual(seeded.messages);
      expect(result.streaming).toEqual(seeded.streaming);
    });

    it('leaves an already-idle transcript (no active turn) intact too', () => {
      const idle = emptyTranscript();
      const result = applyServerFrame(idle, error);

      expect(result).toEqual(idle);
    });
  });

  describe('malformed frames', () => {
    it('returns the transcript unchanged for an unrecognized frame type', () => {
      const bogus = { type: 'bogus', id: 'x' } as unknown as MobileWsServerFrame;
      const t = applyServerFrame(emptyTranscript(), accepted);

      const result = applyServerFrame(t, bogus);

      expect(result).toEqual(t);
    });

    it('returns the transcript unchanged for a null frame (JSON.parse("null") is valid JSON)', () => {
      const t = applyServerFrame(emptyTranscript(), accepted);

      const result = applyServerFrame(t, null as unknown as MobileWsServerFrame);

      expect(result).toBe(t);
    });
  });

  describe('full stream fixture end-to-end', () => {
    it('replays the whole chat-stream.jsonl sequence to a single finalized message', () => {
      const t = stream.reduce(applyServerFrame, emptyTranscript());

      expect(t.streaming).toBeNull();
      expect(t.messages).toHaveLength(1);
      expect(t.messages[0].status).toBe('completed');
      expect(t.messages[0].content.type).toBe('assistant');
    });
  });
});
