import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

// Hermetic by design: App composes Clerk's SignedIn/SignedOut boundary with
// Shell, but neither ClerkProvider nor Shell's real dependencies (control
// plane, credential store) belong in this test — they're covered directly
// in ui/Shell.test.tsx and ui/GatewayPicker.test.tsx with fakes. This test
// only proves App wires the sign-in/signed-in split correctly, with
// `authState.signedIn` standing in for Clerk's real auth state.
const authState = vi.hoisted(() => ({ signedIn: true }));

vi.mock('@clerk/clerk-react', () => ({
  SignedIn: ({ children }: { children: ReactNode }) =>
    authState.signedIn ? <>{children}</> : null,
  SignedOut: ({ children }: { children: ReactNode }) =>
    authState.signedIn ? null : <>{children}</>,
  useAuth: () => ({ getToken: async () => 'test-token' }),
}));

vi.mock('./ui/Shell.js', () => ({
  Shell: () => <div data-testid="shell" />,
}));

vi.mock('./ui/SignIn.js', () => ({
  SignIn: () => <div data-testid="sign-in" />,
}));

const { default: App } = await import('./App.js');

describe('App', () => {
  afterEach(() => {
    authState.signedIn = true;
  });

  it('renders Shell when signed in', () => {
    authState.signedIn = true;
    render(<App />);
    expect(screen.getByTestId('shell')).toBeTruthy();
    expect(screen.queryByTestId('sign-in')).toBeNull();
  });

  it('renders SignIn when signed out', () => {
    authState.signedIn = false;
    render(<App />);
    expect(screen.getByTestId('sign-in')).toBeTruthy();
    expect(screen.queryByTestId('shell')).toBeNull();
  });
});
