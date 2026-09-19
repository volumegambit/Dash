import { SpeechError, type SpeechErrorCode, httpStatusFor } from './errors.js';

describe('httpStatusFor', () => {
  const cases: Array<[SpeechErrorCode, number]> = [
    ['unauthorized', 401],
    ['unavailable', 503],
    ['too_long', 413],
    ['too_large', 413],
    ['invalid', 400],
    ['provider', 502],
    ['network', 502],
  ];

  it.each(cases)('maps %s to %d', (code, status) => {
    expect(httpStatusFor(code)).toBe(status);
  });
});

describe('SpeechError', () => {
  it('is an Error carrying a code, message, and optional status', () => {
    const err = new SpeechError('invalid', 'bad request', 400);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('invalid');
    expect(err.message).toBe('bad request');
    expect(err.status).toBe(400);
  });

  it('status defaults to undefined when omitted', () => {
    const err = new SpeechError('provider', 'upstream failed');
    expect(err.status).toBeUndefined();
  });
});
