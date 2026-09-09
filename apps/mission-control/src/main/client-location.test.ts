import { readCoarseLocation } from './client-location.js';

describe('readCoarseLocation (Mission Control main process)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const source = {
    getLocale: () => 'en-SG',
    getLocaleCountryCode: () => 'SG',
  };

  it('reads the coarse tier from the injected Electron locale source', () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-480);
    const out = readCoarseLocation(source);
    expect(out).toMatchObject({ locale: 'en-SG', region: 'SG', utcOffsetMinutes: 480 });
    expect(typeof out?.timezone).toBe('string');
    expect(out?.timezone).not.toBe('');
  });

  it('negates the JS west-positive offset into minutes east of UTC', () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(240);
    expect(readCoarseLocation(source)?.utcOffsetMinutes).toBe(-240);
  });

  it('omits region when Electron reports an empty country code', () => {
    // Never send '' -- the gateway rejects the whole coarse tier on one.
    const out = readCoarseLocation({ getLocale: () => 'en', getLocaleCountryCode: () => '' });
    expect(out).toBeDefined();
    expect(Object.hasOwn(out as object, 'region')).toBe(false);
  });

  it('omits region when the country code is not a 2-letter code', () => {
    const out = readCoarseLocation({ getLocale: () => 'en', getLocaleCountryCode: () => 'SGP' });
    expect(Object.hasOwn(out as object, 'region')).toBe(false);
  });

  it('returns undefined when the locale source is empty', () => {
    expect(
      readCoarseLocation({ getLocale: () => '', getLocaleCountryCode: () => 'SG' }),
    ).toBeUndefined();
  });

  it('never precises: Mission Control is coarse-only by decision', () => {
    expect(readCoarseLocation(source)?.precise).toBeUndefined();
  });

  it('survives a throwing locale source', () => {
    expect(
      readCoarseLocation({
        getLocale: () => {
          throw new Error('app not ready');
        },
        getLocaleCountryCode: () => 'SG',
      }),
    ).toBeUndefined();
  });
});
