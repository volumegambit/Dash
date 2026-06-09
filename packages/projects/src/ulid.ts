import { randomBytes } from 'node:crypto';

// Crockford's base32 alphabet (no I, L, O, U).
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number): string {
  let str = '';
  let time = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = time % ENCODING_LEN;
    str = ENCODING[mod] + str;
    time = (time - mod) / ENCODING_LEN;
  }
  return str;
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_LEN);
  let str = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    str += ENCODING[bytes[i] % ENCODING_LEN];
  }
  return str;
}

/**
 * Generate a 26-char ULID. Monotonic enough for our needs (sortable by
 * the millisecond time prefix); the random suffix breaks ties within a
 * millisecond. `now` is injectable for deterministic tests.
 */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

export function projectId(): string {
  return `proj_${ulid()}`;
}

export function issueId(): string {
  return `issue_${ulid()}`;
}

export function commentId(): string {
  return `cmt_${ulid()}`;
}

export function eventId(): string {
  return `evt_${ulid()}`;
}
