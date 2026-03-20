/** Build a secret key name for a provider API key: `{provider}-api-key:{keyName}` */
export function providerSecretKey(provider: string, keyName = 'default'): string {
  return `${provider}-api-key:${keyName}`;
}

/** Extract provider and keyName from a secret key, or null if it doesn't match the pattern. */
export function parseProviderSecretKey(key: string): { provider: string; keyName: string } | null {
  const match = key.match(/^(.+)-api-key:(.+)$/);
  if (!match) return null;
  return { provider: match[1], keyName: match[2] };
}
