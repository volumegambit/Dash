import { StubAuthenticator } from './auth.js';

describe('StubAuthenticator', () => {
  it('maps a present x-test-account header to an accountId', async () => {
    const auth = new StubAuthenticator();
    const result = await auth.authenticate({ 'x-test-account': 'acct-1' });
    expect(result).toEqual({ accountId: 'acct-1' });
  });

  it('returns null when the x-test-account header is absent', async () => {
    const auth = new StubAuthenticator();
    expect(await auth.authenticate({})).toBeNull();
  });

  it('returns null when the x-test-account header is empty', async () => {
    const auth = new StubAuthenticator();
    expect(await auth.authenticate({ 'x-test-account': '' })).toBeNull();
  });

  it('reads the configured header name', async () => {
    const auth = new StubAuthenticator('x-account');
    expect(await auth.authenticate({ 'x-account': 'acct-9' })).toEqual({ accountId: 'acct-9' });
    expect(await auth.authenticate({ 'x-test-account': 'acct-1' })).toBeNull();
  });
});
