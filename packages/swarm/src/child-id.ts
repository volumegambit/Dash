import { randomBytes } from 'node:crypto';

// Crockford's base32 alphabet (no I, L, O, U).
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/**
 * The shape a child conversation id must have (design §7.4). Exported so both
 * the generator and the gateway's routes can assert against ONE pattern —
 * `ConversationIdentifier` in the mobile contract accepts a uuid or exactly
 * this, and a child minted outside the pattern would be unaddressable.
 */
export const CHILD_CONVERSATION_ID_RE = /^sub_[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;

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
 * A child conversation id: `sub_<ulid>`. Time-prefixed so a parent's children
 * sort in spawn order, and prefixed so a glance at a session dir or a log line
 * says whether an id is a user conversation or a sub-agent.
 *
 * A local 26-char ULID rather than `@dash/projects`' — `@dash/swarm` depends on
 * `@dash/agent` alone, and pulling a database package in for one id generator
 * would be a heavier coupling than the thirty lines above.
 */
export function childConversationId(now: number = Date.now()): string {
  return `sub_${encodeTime(now)}${encodeRandom()}`;
}
