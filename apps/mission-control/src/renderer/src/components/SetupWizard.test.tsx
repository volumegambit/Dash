import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { SetupWizard } from './SetupWizard.js';

/**
 * Click through the keychain-consent step so the following assertions
 * start at the "setting-up" → "provider" transition. Used by tests
 * that care about the provider / api-key / done flow, not the consent
 * UI itself.
 */
async function clickThroughConsent(user: UserEvent): Promise<void> {
  // The consent step renders a Continue button. Clicking it transitions
  // to 'setting-up', which mounts SettingUpStep and fires setupEnsureGateway.
  await user.click(screen.getByRole('button', { name: /^Continue$/ }));
}

describe('SetupWizard', () => {
  const noop = () => {};

  describe('keychain-consent step (initial)', () => {
    it('is the initial step when needsSetup=true', () => {
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      expect(screen.getByText('Welcome to Dash')).toBeInTheDocument();
      expect(screen.getByText(/secure credential store/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Continue$/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Cancel and quit/ })).toBeInTheDocument();
    });

    it('does NOT call setupEnsureGateway on mount', () => {
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      // The whole point of the consent step: keychain access (which
      // happens inside setupEnsureGateway) must not fire until the
      // user has acknowledged the consent modal.
      expect(mockApi.setupEnsureGateway).not.toHaveBeenCalled();
    });

    it('calls setupEnsureGateway only after user clicks Continue', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      expect(mockApi.setupEnsureGateway).not.toHaveBeenCalled();

      await clickThroughConsent(user);

      await waitFor(() => {
        expect(mockApi.setupEnsureGateway).toHaveBeenCalledOnce();
      });
    });

    it('calls appQuit when Cancel clicked', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await user.click(screen.getByRole('button', { name: /Cancel and quit/ }));

      expect(mockApi.appQuit).toHaveBeenCalledOnce();
    });
  });

  describe('setting-up step (post-consent)', () => {
    it('shows loading UI after Continue and advances to provider step on ready', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      await clickThroughConsent(user);
      // Loading UI is visible between clicking Continue and the mock
      // setupEnsureGateway resolving. On success we advance to the
      // provider step.
      await screen.findByText('Choose Your AI Provider');
    });

    it('shows gateway error if setupEnsureGateway rejects', async () => {
      const user = userEvent.setup();
      mockApi.setupEnsureGateway.mockRejectedValue(new Error('Gateway failed to start'));
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await clickThroughConsent(user);

      await screen.findByText('Gateway Error');
      expect(screen.getByText('Gateway failed to start')).toBeInTheDocument();
    });
  });

  describe('done step (needsSetup=false)', () => {
    it('skips the wizard and lands directly on done', () => {
      render(<SetupWizard needsSetup={false} onComplete={noop} />);
      expect(screen.getByText("You're All Set!")).toBeInTheDocument();
      expect(screen.getByText('Get Started')).toBeInTheDocument();
      // Skipping to 'done' must NOT trigger setupEnsureGateway — the
      // caller already determined the gateway is live.
      expect(mockApi.setupEnsureGateway).not.toHaveBeenCalled();
    });

    it('calls onComplete when "Get Started" clicked', async () => {
      const user = userEvent.setup();
      const onComplete = vi.fn();
      render(<SetupWizard needsSetup={false} onComplete={onComplete} />);

      await user.click(screen.getByText('Get Started'));

      expect(onComplete).toHaveBeenCalledOnce();
    });
  });

  describe('provider step', () => {
    it('shows "Claude by Anthropic" and "Continue with Claude by Anthropic" by default', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');
      expect(screen.getByText('Claude by Anthropic')).toBeInTheDocument();
      expect(screen.getByText(/Continue with Claude by Anthropic/)).toBeInTheDocument();
    });
  });

  describe('api key step', () => {
    it('calls credentialsSet with anthropic-api-key:default on save', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');

      // Navigate from provider to api-key step
      await user.click(screen.getByText(/Continue with Claude by Anthropic/));
      expect(screen.getByText('Connect to Claude')).toBeInTheDocument();

      await user.type(screen.getByPlaceholderText('sk-ant-...'), 'sk-ant-test-key-123');
      await user.click(screen.getByText('Save API Key'));

      expect(mockApi.credentialsSet).toHaveBeenCalledWith(
        'anthropic-api-key:default',
        'sk-ant-test-key-123',
      );
      await screen.findByText("You're All Set!");
    });

    it('shows error message when credentialsSet rejects', async () => {
      const user = userEvent.setup();
      mockApi.credentialsSet.mockRejectedValue(new Error('Network error'));
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');
      await user.click(screen.getByText(/Continue with Claude by Anthropic/));
      await user.type(screen.getByPlaceholderText('sk-ant-...'), 'sk-ant-test-key-123');
      await user.click(screen.getByText('Save API Key'));

      await screen.findByText('Network error');
    });

    it('navigates back from api-key to provider', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');
      await user.click(screen.getByText(/Continue with Claude by Anthropic/));
      expect(screen.getByText('Connect to Claude')).toBeInTheDocument();

      await user.click(screen.getByText('Back'));
      expect(screen.getByText('Choose Your AI Provider')).toBeInTheDocument();
    });

    it('calls openExternal with console URL when console link clicked', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');
      await user.click(screen.getByText(/Continue with Claude by Anthropic/));

      await user.click(screen.getByText('console.anthropic.com'));

      expect(mockApi.openExternal).toHaveBeenCalledWith('https://console.anthropic.com');
    });
  });
});
