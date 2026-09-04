import { ClerkProvider } from '@clerk/clerk-react';
import App from './App.js';

export interface AppRootProps {
  clerkPublishableKey: string;
}

/**
 * Guards `ClerkProvider` mounting: `@clerk/clerk-react` throws synchronously
 * if `publishableKey` is empty/missing, which would take down the entire app
 * with an unhandled error on a misconfigured deploy (missing/blank
 * `VITE_CLERK_PUBLISHABLE_KEY`). Render a plain configuration-error message
 * instead so the failure is legible rather than a crash.
 */
export function AppRoot({ clerkPublishableKey }: AppRootProps) {
  if (!clerkPublishableKey) {
    return (
      <main>
        <h1>Dash</h1>
        <p>Configuration error: VITE_CLERK_PUBLISHABLE_KEY is not set for this deployment.</p>
      </main>
    );
  }

  return (
    <ClerkProvider publishableKey={clerkPublishableKey}>
      <App />
    </ClerkProvider>
  );
}

export default AppRoot;
