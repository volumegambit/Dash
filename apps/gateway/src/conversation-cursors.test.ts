import {
  decodeConversationCursor,
  decodeMessageCursor,
  encodeConversationCursor,
  encodeMessageCursor,
} from './conversation-cursors.js';

function rawCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function expectInvalid(run: () => unknown): void {
  expect(run).toThrowError(
    expect.objectContaining({
      code: 'validation_failed',
      message: 'Invalid pagination cursor',
      status: 400,
      retryable: false,
    }),
  );
}

describe('conversation cursors', () => {
  it('round-trips canonical conversation and message cursors', () => {
    const conversation = {
      updatedAt: '2026-07-12T00:00:00.000Z',
      id: '00000000-0000-4000-8000-000000000001',
    };
    const message = {
      ordinal: 42,
      id: '00000000-0000-4000-8000-000000000002',
    };

    expect(decodeConversationCursor(encodeConversationCursor(conversation))).toEqual(conversation);
    expect(decodeMessageCursor(encodeMessageCursor(message))).toEqual(message);
  });

  it('rejects a cursor with a non-base64url suffix even when Node can decode it', () => {
    const cursor = encodeConversationCursor({
      updatedAt: '2026-07-12T00:00:00.000Z',
      id: '00000000-0000-4000-8000-000000000001',
    });

    expectInvalid(() => decodeConversationCursor(`${cursor}!`));
  });

  it('rejects padded, malformed, and non-canonical cursor text', () => {
    const cursor = encodeMessageCursor({ ordinal: 1, id: 'message-1' });
    expectInvalid(() => decodeMessageCursor(`${cursor}=`));
    expectInvalid(() => decodeMessageCursor(''));
    expectInvalid(() => decodeMessageCursor('___'));
  });

  it('rejects wrong versions, field types, and extra fields', () => {
    expectInvalid(() =>
      decodeConversationCursor(
        rawCursor({ v: 2, updatedAt: '2026-07-12T00:00:00.000Z', id: 'conversation-1' }),
      ),
    );
    expectInvalid(() =>
      decodeConversationCursor(rawCursor({ v: 1, updatedAt: 123, id: 'conversation-1' })),
    );
    expectInvalid(() => decodeMessageCursor(rawCursor({ v: 1, ordinal: '1', id: 'message-1' })));
    expectInvalid(() =>
      decodeMessageCursor(rawCursor({ v: 1, ordinal: 1, id: 'message-1', extra: true })),
    );
  });

  it('rejects non-RFC-3339 timestamps, empty ids, and non-positive ordinals', () => {
    expectInvalid(() =>
      decodeConversationCursor(rawCursor({ v: 1, updatedAt: '2026-07-12', id: 'conversation-1' })),
    );
    expectInvalid(() =>
      decodeConversationCursor(rawCursor({ v: 1, updatedAt: '2026-07-12T00:00:00.000Z', id: '' })),
    );
    expectInvalid(() => decodeMessageCursor(rawCursor({ v: 1, ordinal: 0, id: 'message-1' })));
    expectInvalid(() => decodeMessageCursor(rawCursor({ v: 1, ordinal: 1, id: '' })));
  });
});
