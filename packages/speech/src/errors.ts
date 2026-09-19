export type SpeechErrorCode =
  | 'unauthorized'
  | 'unavailable'
  | 'too_long'
  | 'too_large'
  | 'invalid'
  | 'provider'
  | 'network';

export class SpeechError extends Error {
  constructor(
    readonly code: SpeechErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SpeechError';
  }
}

const STATUS_BY_CODE: Record<SpeechErrorCode, number> = {
  unauthorized: 401,
  unavailable: 503,
  too_long: 413,
  too_large: 413,
  invalid: 400,
  provider: 502,
  network: 502,
};

export function httpStatusFor(code: SpeechErrorCode): number {
  return STATUS_BY_CODE[code];
}
