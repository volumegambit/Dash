import { readClientLocation, readCoarseLocation } from './location.js';

describe('readCoarseLocation', () => {
  const realDTF = Intl.DateTimeFormat;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Intl.DateTimeFormat = realDTF;
  });

  function stubEnv(timeZone: string | undefined, language: string, offsetMinutes: number): void {
    Intl.DateTimeFormat = (() => ({
      resolvedOptions: () => ({ timeZone }),
    })) as unknown as typeof Intl.DateTimeFormat;
    vi.stubGlobal('navigator', { language });
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(offsetMinutes);
  }

  it('negates the JS west-positive offset into minutes east of UTC', () => {
    // Singapore: getTimezoneOffset() === -480 (west-positive) → 480 east.
    stubEnv('Asia/Singapore', 'en-SG', -480);
    expect(readCoarseLocation()).toEqual({
      timezone: 'Asia/Singapore',
      utcOffsetMinutes: 480,
      locale: 'en-SG',
      region: 'SG',
    });
  });

  it('negates a positive offset into a negative one', () => {
    // New York in EDT: getTimezoneOffset() === 240 → -240 east.
    stubEnv('America/New_York', 'en-US', 240);
    expect(readCoarseLocation()).toMatchObject({
      utcOffsetMinutes: -240,
      region: 'US',
    });
  });

  it('omits region for a language tag that carries none', () => {
    stubEnv('Europe/London', 'en', 0);
    const out = readCoarseLocation();
    expect(out).toBeDefined();
    expect(Object.hasOwn(out as object, 'region')).toBe(false);
  });

  it('returns undefined when the platform reports no time zone', () => {
    stubEnv(undefined, 'en-SG', -480);
    expect(readCoarseLocation()).toBeUndefined();
  });

  it('never returns an empty locale', () => {
    // An empty string would make the gateway reject the WHOLE coarse tier.
    stubEnv('Asia/Singapore', '', -480);
    expect(readCoarseLocation()).toBeUndefined();
  });

  it('survives a platform that throws from Intl', () => {
    Intl.DateTimeFormat = (() => {
      throw new Error('no Intl');
    }) as unknown as typeof Intl.DateTimeFormat;
    vi.stubGlobal('navigator', { language: 'en-SG' });
    expect(readCoarseLocation()).toBeUndefined();
  });

  it('readClientLocation returns the coarse tier when precise is off', () => {
    stubEnv('Asia/Singapore', 'en-SG', -480);
    expect(readClientLocation()).toEqual({
      timezone: 'Asia/Singapore',
      utcOffsetMinutes: 480,
      locale: 'en-SG',
      region: 'SG',
    });
  });
});
