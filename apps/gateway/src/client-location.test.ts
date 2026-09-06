import { toClientLocation } from './client-location.js';

const coarse = {
  timezone: 'Asia/Singapore',
  utcOffsetMinutes: 480,
  locale: 'en-SG',
  region: 'SG',
};

const precise = {
  latitude: 1.2966,
  longitude: 103.7764,
  accuracyMeters: 12,
  capturedAt: '2026-09-06T10:11:02Z',
  place: 'NUS',
};

describe('toClientLocation', () => {
  it('accepts a well-formed coarse location', () => {
    expect(toClientLocation(coarse)).toEqual(coarse);
  });

  it('accepts a well-formed precise location', () => {
    expect(toClientLocation({ ...coarse, precise })).toEqual({ ...coarse, precise });
  });

  it('returns undefined for a non-object', () => {
    expect(toClientLocation(undefined)).toBeUndefined();
    expect(toClientLocation(null)).toBeUndefined();
    expect(toClientLocation('Asia/Singapore')).toBeUndefined();
  });

  it('rejects a missing or empty timezone', () => {
    expect(toClientLocation({ ...coarse, timezone: '' })).toBeUndefined();
    const { timezone: _tz, ...noTz } = coarse;
    expect(toClientLocation(noTz)).toBeUndefined();
  });

  it('rejects an out-of-range or non-integer utc offset', () => {
    expect(toClientLocation({ ...coarse, utcOffsetMinutes: 900 })).toBeUndefined();
    expect(toClientLocation({ ...coarse, utcOffsetMinutes: -900 })).toBeUndefined();
    expect(toClientLocation({ ...coarse, utcOffsetMinutes: 4.5 })).toBeUndefined();
    expect(toClientLocation({ ...coarse, utcOffsetMinutes: Number.NaN })).toBeUndefined();
  });

  it('rejects a region that is not two characters', () => {
    expect(toClientLocation({ ...coarse, region: 'SGP' })).toBeUndefined();
  });

  it('caps oversized strings', () => {
    expect(toClientLocation({ ...coarse, locale: 'x'.repeat(201) })).toBeUndefined();
  });

  it('keeps the coarse tier when the precise block is out of range', () => {
    expect(toClientLocation({ ...coarse, precise: { ...precise, latitude: 91 } })).toEqual(coarse);
    expect(toClientLocation({ ...coarse, precise: { ...precise, longitude: -181 } })).toEqual(
      coarse,
    );
    expect(toClientLocation({ ...coarse, precise: { ...precise, accuracyMeters: -1 } })).toEqual(
      coarse,
    );
  });

  it('keeps the coarse tier when capturedAt is unparseable', () => {
    expect(
      toClientLocation({ ...coarse, precise: { ...precise, capturedAt: 'yesterday' } }),
    ).toEqual(coarse);
  });

  it('keeps the coarse tier when precise is not an object', () => {
    expect(toClientLocation({ ...coarse, precise: 'somewhere' })).toEqual(coarse);
  });

  it('drops an absent optional region rather than emitting undefined', () => {
    const { region: _r, ...noRegion } = coarse;
    const out = toClientLocation(noRegion);
    expect(out).toEqual(noRegion);
    expect(Object.hasOwn(out as object, 'region')).toBe(false);
  });

  it('drops a precise block whose place is not a string', () => {
    expect(toClientLocation({ ...coarse, precise: { ...precise, place: 42 } })).toEqual(coarse);
  });

  it('ignores unknown extra properties rather than failing the whole location', () => {
    expect(toClientLocation({ ...coarse, altitude: 30 })).toEqual(coarse);
  });
});
