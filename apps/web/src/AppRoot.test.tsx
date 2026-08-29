import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

// Hermetic: never let a real ClerkProvider mount in tests (no network, and
// the whole point of this test is the *guard* that keeps it from mounting
// at all when misconfigured). '@clerk/clerk-react' is fully mocked; the fake
// ClerkProvider just renders its children with a marker so the "configured"
// case is distinguishable from the "misconfigured" case without needing the
// real component.
vi.mock('@clerk/clerk-react', () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="clerk-provider">{children}</div>
  ),
}));

vi.mock('./App.js', () => ({
  default: () => <div data-testid="app" />,
}));

const { AppRoot } = await import('./AppRoot.js');

describe('AppRoot', () => {
  it('renders a configuration-error message instead of mounting ClerkProvider when the key is empty', () => {
    render(<AppRoot clerkPublishableKey="" />);
    expect(
      screen.getByText(
        'Configuration error: VITE_CLERK_PUBLISHABLE_KEY is not set for this deployment.',
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('clerk-provider')).toBeNull();
    expect(screen.queryByTestId('app')).toBeNull();
  });

  it('mounts ClerkProvider around App when a key is configured', () => {
    render(<AppRoot clerkPublishableKey="pk_test_abc" />);
    expect(screen.getByTestId('clerk-provider')).toBeTruthy();
    expect(screen.getByTestId('app')).toBeTruthy();
  });
});
