import { SignedIn, SignedOut, useAuth } from '@clerk/clerk-react';
import { useMemo } from 'react';
import type { TokenSource } from './api/rest.js';
import { ControlPlaneClient } from './auth/control-plane.js';
import { CredentialStore } from './auth/credential-store.js';
import { config } from './config.js';
import { Shell } from './ui/Shell.js';
import { SignIn } from './ui/SignIn.js';

/** Mounted only under `<SignedIn>` (see `App` below), so `useAuth()` always
 * has a live Clerk session to mint tokens from. Builds the real
 * `ControlPlaneClient`/`CredentialStore` Shell needs, wiring Clerk's
 * `getToken` as the `TokenSource` for the control plane only — once a
 * gateway is picked, Shell authenticates to it with the gateway's own chat
 * token and relay credential (from `CredentialStore`), never the Clerk
 * token, so `Shell` has no `tokens` prop to receive here. */
function AuthenticatedShell() {
  const { getToken } = useAuth();

  const tokens = useMemo<TokenSource>(
    () => ({
      async getToken() {
        const token = await getToken();
        if (!token) throw new Error('No Clerk session token available');
        return token;
      },
    }),
    [getToken],
  );

  const controlPlaneClient = useMemo(
    () => new ControlPlaneClient(config.controlPlaneUrl, tokens),
    [tokens],
  );
  const credentialStore = useMemo(() => new CredentialStore(), []);

  return (
    <Shell
      controlPlaneClient={controlPlaneClient}
      credentialStore={credentialStore}
      relayDomain={config.relayDomain}
    />
  );
}

export default function App() {
  return (
    <>
      <SignedOut>
        <SignIn />
      </SignedOut>
      <SignedIn>
        <AuthenticatedShell />
      </SignedIn>
    </>
  );
}
