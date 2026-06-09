import { describe, expect, it } from 'vitest';
import { commentId, eventId, issueId, projectId, ulid } from './ulid.js';

describe('ulid', () => {
  it('produces a 26-char Crockford base32 string', () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('produces unique values', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => ulid()));
    expect(ids.size).toBe(1000);
  });

  it('sorts lexicographically by creation time', () => {
    const a = ulid(1000);
    const b = ulid(2000);
    expect(a < b).toBe(true);
  });

  it('prefixes entity ids', () => {
    expect(projectId()).toMatch(/^proj_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(issueId()).toMatch(/^issue_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(commentId()).toMatch(/^cmt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(eventId()).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
