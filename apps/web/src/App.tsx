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
 * `ControlPlaneClient`/`CredentialStore` Shell needs and wires Clerk's
 * `getToken` as the `TokenSource` used for both the control plane and (once
 * a gateway is picked) the mobile v1 REST/WS surface. */
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
      tokens={tokens}
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
