import {
  __resetPreciseLocationForTests,
  isPreciseLocationAvailable,
  isPreciseLocationEnabled,
  readClientLocation,
  readCoarseLocation,
  setPreciseLocationEnabled,
} from './location.js';

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

describe('precise location opt-in', () => {
  const realDTF = Intl.DateTimeFormat;

  beforeEach(() => {
    __resetPreciseLocationForTests();
    localStorage.clear();
    Intl.DateTimeFormat = (() => ({
      resolvedOptions: () => ({ timeZone: 'Asia/Singapore' }),
    })) as unknown as typeof Intl.DateTimeFormat;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Intl.DateTimeFormat = realDTF;
    localStorage.clear();
  });

  function stubGeo(position?: { lat: number; lon: number; accuracy: number }, fail?: unknown) {
    vi.stubGlobal('navigator', {
      language: 'en-SG',
      geolocation: {
        // The real getCurrentPosition is ALWAYS asynchronous. Keeping the
        // stub async is what makes the "a send never waits on a fix"
        // assertion below meaningful.
        getCurrentPosition: (ok: (p: unknown) => void, err?: (e: unknown) => void): void => {
          queueMicrotask(() => {
            if (fail !== undefined) {
              err?.(fail);
              return;
            }
            ok({
              coords: {
                latitude: position?.lat ?? 1.2966,
                longitude: position?.lon ?? 103.7764,
                accuracy: position?.accuracy ?? 12,
              },
              timestamp: Date.UTC(2026, 8, 6, 10, 11, 2),
            });
          });
        },
      },
    });
    vi.stubGlobal('isSecureContext', true);
  }

  it('is disabled by default', () => {
    stubGeo();
    expect(isPreciseLocationEnabled()).toBe(false);
    expect(readClientLocation()?.precise).toBeUndefined();
  });

  it('persists the opt-in to localStorage', () => {
    stubGeo();
    setPreciseLocationEnabled(true);
    expect(isPreciseLocationEnabled()).toBe(true);
    expect(localStorage.getItem('dash.location.precise')).toBe('1');
    setPreciseLocationEnabled(false);
    expect(isPreciseLocationEnabled()).toBe(false);
    expect(localStorage.getItem('dash.location.precise')).toBeNull();
  });

  it('reports unavailable outside a secure context', () => {
    stubGeo();
    vi.stubGlobal('isSecureContext', false);
    expect(isPreciseLocationAvailable()).toBe(false);
  });

  it('reports unavailable when the browser has no geolocation', () => {
    vi.stubGlobal('navigator', { language: 'en-SG' });
    vi.stubGlobal('isSecureContext', true);
    expect(isPreciseLocationAvailable()).toBe(false);
  });

  it('attaches a cached fix once one has been captured', async () => {
    stubGeo();
    setPreciseLocationEnabled(true);
    // First read kicks off the async refresh and returns coarse only --
    // sendMessage is synchronous and must never block on a geolocation fix.
    expect(readClientLocation()?.precise).toBeUndefined();
    await vi.waitFor(() => expect(readClientLocation()?.precise).toBeDefined());

    const precise = readClientLocation()?.precise;
    expect(precise).toMatchObject({
      latitude: 1.2966,
      longitude: 103.7764,
      accuracyMeters: 12,
    });
    expect(precise?.capturedAt).toBe(new Date(Date.UTC(2026, 8, 6, 10, 11, 2)).toISOString());
  });

  it('degrades to coarse when the permission is denied and never throws', async () => {
    stubGeo(undefined, { code: 1, message: 'User denied Geolocation' });
    setPreciseLocationEnabled(true);
    expect(() => readClientLocation()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    const out = readClientLocation();
    expect(out).toBeDefined();
    expect(out?.precise).toBeUndefined();
    expect(out?.timezone).toBe('Asia/Singapore');
  });

  it('drops the cached fix when the user opts back out', async () => {
    stubGeo();
    setPreciseLocationEnabled(true);
    await vi.waitFor(() => expect(readClientLocation()?.precise).toBeDefined());
    setPreciseLocationEnabled(false);
    expect(readClientLocation()?.precise).toBeUndefined();
  });
});
