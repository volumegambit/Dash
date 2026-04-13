export class VoiceError extends Error {
  constructor(
    message: string, 
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'VoiceError';
  }
}

export class TranscriptionError extends VoiceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'TRANSCRIPTION_FAILED', details);
    this.name = 'TranscriptionError';
  }
}

export class SynthesisError extends VoiceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'SYNTHESIS_FAILED', details);
    this.name = 'SynthesisError';
  }
}

export class AudioFormatError extends VoiceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'AUDIO_FORMAT_ERROR', details);
    this.name = 'AudioFormatError';
  }
}

export class VoiceProviderError extends VoiceError {
  constructor(
    message: string, 
    public readonly provider: string,
    details?: Record<string, unknown>
  ) {
    super(message, 'VOICE_PROVIDER_ERROR', details);
    this.name = 'VoiceProviderError';
  }
}

export const VoiceErrorCodes = {
  TRANSCRIPTION_FAILED: 'TRANSCRIPTION_FAILED',
  SYNTHESIS_FAILED: 'SYNTHESIS_FAILED',
  AUDIO_FORMAT_ERROR: 'AUDIO_FORMAT_ERROR',
  VOICE_PROVIDER_ERROR: 'VOICE_PROVIDER_ERROR',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR'
} as const;