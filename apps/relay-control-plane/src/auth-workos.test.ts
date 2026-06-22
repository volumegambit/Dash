import type { AccessTokenVerifier } from './auth-workos.js';
import { WorkosAuthenticator } from './auth-workos.js';

// A fake verifier: the WorkosAuthenticator unit is the bearer-extraction +
// account mapping; the WorkOS/JWKS verification is a separate seam injected here
// so these tests need no network and no real @workos-inc/node / jose.
const verifier: AccessTokenVerifier = {
  verify: async (token) => (token === 'good-token' ? { accountId: 'org_42' } : null),
};

test('maps a valid Bearer token to its account', async () => {
  const auth = new WorkosAuthenticator(verifier);
  expect(await auth.authenticate({ authorization: 'Bearer good-token' })).toEqual({
    accountId: 'org_42',
  });
});

test('returns null when the Authorization header is absent', async () => {
  const auth = new WorkosAuthenticator(verifier);
  expect(await auth.authenticate({})).toBeNull();
});

test('returns null for a non-Bearer or malformed Authorization header', async () => {
  const auth = new WorkosAuthenticator(verifier);
  expect(await auth.authenticate({ authorization: 'Basic abc' })).toBeNull();
  expect(await auth.authenticate({ authorization: 'good-token' })).toBeNull();
});

test('returns null when the verifier rejects the token', async () => {
  const auth = new WorkosAuthenticator(verifier);
  expect(await auth.authenticate({ authorization: 'Bearer not-good' })).toBeNull();
});
