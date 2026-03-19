import { parseProviderSecretKey, providerSecretKey } from './process.js';

describe('providerSecretKey', () => {
  it('builds a key with default keyName', () => {
    expect(providerSecretKey('anthropic')).toBe('anthropic-api-key:default');
  });

  it('builds a key with custom keyName', () => {
    expect(providerSecretKey('openai', 'high-volume')).toBe('openai-api-key:high-volume');
  });

  it('roundtrips with parseProviderSecretKey', () => {
    const key = providerSecretKey('brave');
    const parsed = parseProviderSecretKey(key);
    expect(parsed).toEqual({ provider: 'brave', keyName: 'default' });
  });

  it('roundtrips with custom keyName', () => {
    const key = providerSecretKey('google', 'prod');
    const parsed = parseProviderSecretKey(key);
    expect(parsed).toEqual({ provider: 'google', keyName: 'prod' });
  });
});

describe('parseProviderSecretKey', () => {
  it('parses a valid provider secret key', () => {
    expect(parseProviderSecretKey('anthropic-api-key:default')).toEqual({
      provider: 'anthropic',
      keyName: 'default',
    });
  });

  it('parses a key with hyphens in name', () => {
    expect(parseProviderSecretKey('anthropic-api-key:high-volume')).toEqual({
      provider: 'anthropic',
      keyName: 'high-volume',
    });
  });

  it('parses openai keys', () => {
    expect(parseProviderSecretKey('openai-api-key:default')).toEqual({
      provider: 'openai',
      keyName: 'default',
    });
  });

  it('returns null for non-provider keys', () => {
    expect(parseProviderSecretKey('telegram-bot-token')).toBeNull();
    expect(parseProviderSecretKey('agent-token:abc123')).toBeNull();
  });

  it('returns null for keys without a key name', () => {
    expect(parseProviderSecretKey('anthropic-api-key')).toBeNull();
  });
});
