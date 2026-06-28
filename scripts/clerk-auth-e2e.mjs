#!/usr/bin/env node
// Headless, REPEATABLE end-to-end test of the FULL Clerk OAuth (OIDC) flow that
// the Dash control plane relies on — no human, no browser, no manual sign-in.
//
// What it proves, end to end, against the LIVE Clerk dev instance:
//   1. A `+clerk_test` user (OTP 424242, no real email sent) plus an
//      organization + membership is created via the Clerk Backend API.
//   2. The Clerk Frontend API (FAPI) sign-in flow runs purely over HTTP:
//      dev_browser handshake -> sign_ins -> prepare/attempt email_code -> an
//      active session whose token already carries the org (single membership =>
//      auto-selected active org, so `org_id` is present).
//   3. The OAuth authorize endpoint issues an authorization `code` to the
//      loopback redirect WITHOUT following the redirect (PKCE S256, public
//      client), the `code` is exchanged at /oauth/token for an `id_token`, and
//      that `id_token` is run through the REAL control-plane verifier
//      (`createClerkVerifier` in apps/relay-control-plane/src/auth-clerk.ts)
//      against the REAL JWKS. We assert it returns `{ accountId: <org_id> }`.
//   4. The test user (and its org) are deleted afterwards, so reruns are clean.
//
// APPROACH: pure HTTP/API — no Playwright, no headless browser. The only
// dev-instance setting it touches is the OAuth app's `consent_screen_enabled`,
// which it flips to `false` for the duration and RESTORES on exit (so the
// authorize endpoint redirects straight to the loopback with the code instead
// of bouncing to the hosted consent page).
//
// THIS MAKES REAL CLERK DEV CALLS (and tiny, free FAPI/Backend-API calls). Like
// `plugins:e2e`, it is NOT part of `npm test` / `preflight` / CI. Run it
// manually with `npm run clerk:e2e`.
//
// PREREQS:
//   - Node >= 22.12 (undici / fetch getSetCookie).
//   - Clerk CLI authenticated for the Backend API: it shells out to
//     `npx -y clerk@latest api ... --yes`. Run `clerk config pull` once if the
//     CLI is not yet authenticated. The CLI must be able to hit api.clerk.com/v1
//     for the configured dev instance.
//
// Run from source so the TypeScript verifier imports directly:
//   node --import tsx scripts/clerk-auth-e2e.mjs   (== `npm run clerk:e2e`)

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createClerkVerifier } from '../apps/relay-control-plane/src/auth-clerk.ts';

// Run a command, capturing stdout/stderr. We close stdin immediately: the Clerk
// CLI blocks waiting on stdin in a non-TTY even with `--yes`, so feeding it EOF
// is what actually unblocks it.
function run(cmd, args, { timeout = 120_000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });
}

// ---------------------------------------------------------------------------
// Config (non-secret) — matches /tmp/dash-e2e/clerk-config.json.
// ---------------------------------------------------------------------------
const FAPI = 'resolved-seahorse-39.clerk.accounts.dev';
const ISSUER = `https://${FAPI}`;
const CLIENT_ID = '5KwDiIAztapVfeoE';
const OAUTH_APP_ID = 'oa_3FlEQdAJyEXvNabwPo4JcBdwNZU';
const REDIRECT_URI = 'http://127.0.0.1:53682/callback';
// MUST mirror Mission Control's requested scopes (apps/mission-control/src/main/
// control-plane.ts SCOPES) so this test faithfully exercises the real sign-in.
// `user:org:read` is what makes Clerk attach the org to the OAuth tokens: with it,
// Clerk populates `org_id` from the user's active organization (our session has
// exactly one, auto-selected), so the id_token carries the org_id the
// control-plane verifier requires. `offline_access` matches MC (refresh token).
const SCOPE = 'openid profile email offline_access user:org:read';
const TEST_EMAIL = 'dash-e2e+clerk_test@example.com';
const ORG_NAME = 'Dash E2E Org';
// A clerk-js version is required on FAPI calls; any recent major works.
const CLERK_JS_VERSION = '5.999.0';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

let stepNo = 0;
function step(msg) {
  stepNo += 1;
  console.log(`\n[${stepNo}] ${msg}`);
}
function ok(msg) {
  console.log(`  ✓ ${msg}`);
}
function fail(msg) {
  console.error(`  ✗ ${msg}`);
}

// ---------------------------------------------------------------------------
// Clerk Backend API via the official CLI (handles auth + base URL for us).
// ---------------------------------------------------------------------------
async function clerk(path, method, body) {
  const args = ['-y', 'clerk@latest', 'api', path, '-X', method ?? 'GET'];
  if (body !== undefined) args.push('-d', JSON.stringify(body));
  args.push('--yes'); // never block on an interactive prompt in a non-TTY
  const { stdout } = await run('npx', args);
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // CLI sometimes prints non-JSON noise on errors; surface it.
    throw new Error(`Clerk CLI returned non-JSON for ${method} ${path}: ${text.slice(0, 400)}`);
  }
}

// ---------------------------------------------------------------------------
// Frontend API helpers (cookieless dev mode: state carried by __clerk_db_jwt).
// ---------------------------------------------------------------------------
function makeFapiClient(dbJwt) {
  const jar = new Map();
  const capture = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const m = /^([^=]+)=([^;]+)/.exec(c);
      if (m) jar.set(m[1], m[2]);
    }
  };
  const cookieHeader = () => {
    const all = new Map(jar);
    all.set('__clerk_db_jwt', dbJwt);
    return [...all.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  };
  const url = (path, params = {}) => {
    const u = new URL(`${ISSUER}${path}`);
    u.searchParams.set('__clerk_db_jwt', dbJwt);
    u.searchParams.set('_clerk_js_version', CLERK_JS_VERSION);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  };
  async function post(path, form, params = {}) {
    const res = await fetch(url(path, params), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'http://localhost',
        Cookie: cookieHeader(),
      },
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
    });
    capture(res);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }
  return { cookieHeader, url, post };
}

// ---------------------------------------------------------------------------
// Idempotent cleanup: delete any pre-existing test user (Clerk cascades the
// membership; the org is created per-run and removed explicitly below).
// ---------------------------------------------------------------------------
async function deleteTestUsers() {
  const res = await clerk(`/users?email_address=${encodeURIComponent(TEST_EMAIL)}`);
  const users = Array.isArray(res) ? res : (res?.data ?? []);
  for (const u of users) {
    await clerk(`/users/${u.id}`, 'DELETE');
    ok(`deleted stale user ${u.id}`);
  }
  return users.length;
}

async function deleteOrg(orgId) {
  if (!orgId) return;
  try {
    await clerk(`/organizations/${orgId}`, 'DELETE');
    ok(`deleted org ${orgId}`);
  } catch (e) {
    fail(`could not delete org ${orgId}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  let userId = null;
  let orgId = null;
  let consentWasEnabled = null; // remember to restore the dev-instance setting

  try {
    // -- 0. Read + temporarily disable the OAuth consent screen -------------
    step('Read OAuth app + disable consent screen (restored on exit)');
    const app = await clerk(`/oauth_applications/${OAUTH_APP_ID}`);
    consentWasEnabled = app.consent_screen_enabled === true;
    if (consentWasEnabled) {
      await clerk(`/oauth_applications/${OAUTH_APP_ID}`, 'PATCH', {
        consent_screen_enabled: false,
      });
      ok('consent_screen_enabled: true -> false (will restore)');
    } else {
      ok('consent screen already disabled');
    }

    // -- 1. Idempotent setup: fresh user + org + membership ----------------
    step('Create test user, organization, and membership');
    await deleteTestUsers();
    const user = await clerk('/users', 'POST', {
      email_address: [TEST_EMAIL],
      first_name: 'DashE2E',
      skip_password_requirement: true,
    });
    if (user?.errors) throw new Error(`create user failed: ${JSON.stringify(user.errors)}`);
    userId = user.id;
    ok(`user ${userId} (${TEST_EMAIL})`);

    // created_by makes the user an org:admin member, so the session's active
    // org resolves to this org and the id_token carries its org_id.
    const org = await clerk('/organizations', 'POST', {
      name: ORG_NAME,
      created_by: userId,
    });
    if (org?.errors) throw new Error(`create org failed: ${JSON.stringify(org.errors)}`);
    orgId = org.id;
    ok(`org ${orgId} (${org.slug}), creator membership = org:admin`);

    // -- 2a. dev_browser handshake ----------------------------------------
    step('FAPI dev_browser handshake');
    const dbRes = await fetch(`${ISSUER}/v1/dev_browser`, {
      method: 'POST',
      headers: { Origin: 'http://localhost' },
    });
    const db = await dbRes.json();
    if (!db?.token) throw new Error(`dev_browser failed: ${JSON.stringify(db)}`);
    const fapi = makeFapiClient(db.token);
    ok(`dev_browser ${db.id}`);

    // -- 2b. Email-code sign-in -------------------------------------------
    step('FAPI email-code sign-in (OTP 424242)');
    const si = await fapi.post('/v1/client/sign_ins', { identifier: TEST_EMAIL });
    if (si.status !== 200)
      throw new Error(`sign_ins failed: ${si.status} ${JSON.stringify(si.json)}`);
    const siId = si.json.response.id;
    const factor = (si.json.response.supported_first_factors ?? []).find(
      (f) => f.strategy === 'email_code',
    );
    if (!factor) throw new Error('no email_code first factor available');
    await fapi.post(`/v1/client/sign_ins/${siId}/prepare_first_factor`, {
      strategy: 'email_code',
      email_address_id: factor.email_address_id,
    });
    const att = await fapi.post(`/v1/client/sign_ins/${siId}/attempt_first_factor`, {
      strategy: 'email_code',
      code: '424242',
    });
    const status = att.json?.response?.status;
    if (status !== 'complete') {
      throw new Error(
        `sign-in not complete: status=${status} ${JSON.stringify(att.json?.response)}`,
      );
    }
    const sessionId = att.json.client.last_active_session_id;
    ok(`session ${sessionId} active`);

    // Sanity: confirm the active session token already carries the org.
    const tok = await fapi.post(`/v1/client/sessions/${sessionId}/tokens`, {});
    if (tok.json?.jwt) {
      const claims = JSON.parse(Buffer.from(tok.json.jwt.split('.')[1], 'base64url').toString());
      const activeOrg = claims?.o?.id;
      if (activeOrg !== orgId) {
        throw new Error(`session active org ${activeOrg} != expected ${orgId}`);
      }
      ok(`active org in session token: ${activeOrg}`);
    }

    // -- 2c. OAuth authorize (read code from the 302/303, do NOT follow) ---
    step('OAuth authorize -> read authorization code from redirect');
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const authUrl = fapi.url('/oauth/authorize', {
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const authRes = await fetch(authUrl, {
      headers: { Cookie: fapi.cookieHeader(), Origin: 'http://localhost' },
      redirect: 'manual',
    });
    const location = authRes.headers.get('location');
    if (!location) {
      throw new Error(`authorize did not redirect (status ${authRes.status})`);
    }
    let redirect;
    try {
      redirect = new URL(location);
    } catch {
      throw new Error(`authorize Location is not a URL: ${location}`);
    }
    if (!redirect.href.startsWith(REDIRECT_URI)) {
      // Bounced to sign-in / consent instead of the loopback callback.
      throw new Error(
        `authorize did not redirect to the callback (got ${redirect.origin}${redirect.pathname}). Is the session unrecognised, or is the consent screen still enabled?`,
      );
    }
    const code = redirect.searchParams.get('code');
    const returnedState = redirect.searchParams.get('state');
    if (!code) throw new Error(`no code in callback: ${location}`);
    if (returnedState !== state) throw new Error('state mismatch (possible CSRF)');
    ok('authorization code received (state verified)');

    // -- 2d. Token exchange ------------------------------------------------
    step('OAuth token exchange (authorization_code + PKCE verifier)');
    const tokenRes = await fetch(`${ISSUER}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }).toString(),
    });
    const tokenJson = await tokenRes.json();
    if (tokenRes.status !== 200 || !tokenJson.id_token) {
      throw new Error(`token exchange failed: ${tokenRes.status} ${JSON.stringify(tokenJson)}`);
    }
    const idToken = tokenJson.id_token;
    ok(`token response: ${Object.keys(tokenJson).join(', ')}`);

    // Decode + print the id_token claims for visibility.
    const idClaims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
    step('Decoded id_token claims');
    console.log(
      JSON.stringify(
        {
          iss: idClaims.iss,
          aud: idClaims.aud,
          sub: idClaims.sub,
          org_id: idClaims.org_id,
          exp: idClaims.exp,
          exp_iso: idClaims.exp ? new Date(idClaims.exp * 1000).toISOString() : undefined,
        },
        null,
        2,
      ),
    );

    // -- 3a. Independent JWKS verification (belt-and-braces) ----------------
    step('Verify id_token signature against the REAL JWKS (jose)');
    const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: ISSUER,
      audience: CLIENT_ID,
    });
    ok(`jose verified: iss=${payload.iss} aud=${payload.aud} org_id=${payload.org_id}`);

    // -- 3b. The actual control-plane verifier -----------------------------
    step('Run id_token through the control-plane createClerkVerifier');
    const verifierImpl = createClerkVerifier(FAPI, CLIENT_ID);
    const result = await verifierImpl.verify(idToken);
    if (!result) {
      throw new Error('createClerkVerifier REJECTED the token (returned null)');
    }
    if (result.accountId !== orgId) {
      throw new Error(
        `verifier accountId ${result.accountId} != org_id ${orgId} (idToken.org_id=${idClaims.org_id})`,
      );
    }
    ok(`createClerkVerifier accepted: accountId=${result.accountId}`);

    console.log(`\nPASS — verifier accepted, accountId=${result.accountId}`);
  } finally {
    // -- 4. Cleanup (always) ----------------------------------------------
    step('Cleanup');
    await deleteOrg(orgId);
    if (userId) {
      try {
        await clerk(`/users/${userId}`, 'DELETE');
        ok(`deleted user ${userId}`);
      } catch (e) {
        fail(`could not delete user ${userId}: ${e.message}`);
      }
    }
    // Always sweep any leftover test users with this email, then restore the
    // consent-screen setting we changed.
    try {
      await deleteTestUsers();
    } catch {
      /* best effort */
    }
    if (consentWasEnabled) {
      try {
        await clerk(`/oauth_applications/${OAUTH_APP_ID}`, 'PATCH', {
          consent_screen_enabled: true,
        });
        ok('restored consent_screen_enabled: true');
      } catch (e) {
        fail(`could not restore consent screen: ${e.message}`);
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nFAIL — ${err.message}`);
    process.exit(1);
  });
