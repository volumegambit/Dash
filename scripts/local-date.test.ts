import { localDateStamp } from './local-date.js';

describe('localDateStamp', () => {
  // Pin a UTC+8 zone (no DST) so the local-vs-UTC distinction is visible even
  // on UTC CI machines: just after local midnight the UTC date is still
  // "yesterday", which is exactly the bug this helper exists to avoid.
  beforeAll(() => {
    vi.stubEnv('TZ', 'Asia/Singapore');
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('formats the local calendar date as YYYY-MM-DD', () => {
    expect(localDateStamp(new Date(2026, 6, 6, 12, 0))).toBe('2026-07-06');
  });

  it('zero-pads month and day', () => {
    expect(localDateStamp(new Date(2026, 0, 5, 12, 0))).toBe('2026-01-05');
  });

  it('uses the local date, not the UTC date, just after local midnight', () => {
    const justAfterMidnight = new Date(2026, 6, 6, 0, 30);
    // The UTC date is still the previous day — the old toISOString() stamp.
    expect(justAfterMidnight.toISOString().slice(0, 10)).toBe('2026-07-05');
    expect(localDateStamp(justAfterMidnight)).toBe('2026-07-06');
  });

  it('defaults to now', () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`;
    expect(localDateStamp()).toBe(expected);
  });
});
