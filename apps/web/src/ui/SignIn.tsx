import { SignIn as ClerkSignIn } from '@clerk/clerk-react';

/**
 * Passkey-first sign-in screen. Delegates entirely to Clerk's prebuilt
 * `<SignIn/>` — once passkeys are enabled for this Clerk application in the
 * dashboard, it handles the passkey flow itself. No custom passkey UI here
 * (see Task 12 brief: "no custom passkey UI in v1").
 */
export function SignIn() {
  return (
    <main>
      <h1>Dash</h1>
      <ClerkSignIn />
    </main>
  );
}

export default SignIn;
