import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { SetupWizard } from './SetupWizard.js';

describe('SetupWizard', () => {
  const noop = () => {};

  describe('initial step rendering', () => {
    it('shows setting-up step (loading) when needsSetup=true', () => {
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      expect(screen.getByText('Welcome to DashSquad')).toBeInTheDocument();
      expect(screen.getByText(/Setting up/)).toBeInTheDocument();
    });

    it('calls setupEnsureGateway on mount when needsSetup=true', async () => {
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      await waitFor(() => {
        expect(mockApi.setupEnsureGateway).toHaveBeenCalledOnce();
      });
    });

    it('advances to provider step after gateway is ready', async () => {
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      await screen.findByText('Choose Your AI Provider');
    });

    it('shows done step when needsSetup=false', () => {
      render(<SetupWizard needsSetup={false} onComplete={noop} />);
      expect(screen.getByText("You're All Set!")).toBeInTheDocument();
      expect(screen.getByText('Go to Dashboard')).toBeInTheDocument();
    });

    it('shows gateway error if setupEnsureGateway rejects', async () => {
      mockApi.setupEnsureGateway.mockRejectedValue(new Error('Gateway failed to start'));
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      await screen.findByText('Gateway Error');
      expect(screen.getByText('Gateway failed to start')).toBeInTheDocument();
    });
  });

  describe('provider step', () => {
    it('shows "Claude by Anthropic" and "Continue with Claude by Anthropic" by default', async () => {
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      await screen.findByText('Choose Your AI Provider');
      expect(screen.getByText('Claude by Anthropic')).toBeInTheDocument();
      expect(screen.getByText(/Continue with Claude by Anthropic/)).toBeInTheDocument();
    });
  });

  describe('api key step', () => {
    it('calls credentialsSet with anthropic-api-key:default on save', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      // Wait for provider step
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

      await screen.findByText('Choose Your AI Provider');
      await user.click(screen.getByText(/Continue with Claude by Anthropic/));
      await user.type(screen.getByPlaceholderText('sk-ant-...'), 'sk-ant-test-key-123');
      await user.click(screen.getByText('Save API Key'));

      await screen.findByText('Network error');
    });

    it('navigates back from api-key to provider', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await screen.findByText('Choose Your AI Provider');
      await user.click(screen.getByText(/Continue with Claude by Anthropic/));
      expect(screen.getByText('Connect to Claude')).toBeInTheDocument();

      await user.click(screen.getByText('Back'));
      expect(screen.getByText('Choose Your AI Provider')).toBeInTheDocument();
    });

    it('calls openExternal with console URL when console link clicked', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await screen.findByText('Choose Your AI Provider');
      await user.click(screen.getByText(/Continue with Claude by Anthropic/));

      await user.click(screen.getByText('console.anthropic.com'));

      expect(mockApi.openExternal).toHaveBeenCalledWith('https://console.anthropic.com');
    });
  });

  describe('done step', () => {
    it('calls onComplete when "Go to Dashboard" clicked', async () => {
      const user = userEvent.setup();
      const onComplete = vi.fn();
      render(<SetupWizard needsSetup={false} onComplete={onComplete} />);

      await user.click(screen.getByText('Go to Dashboard'));

      expect(onComplete).toHaveBeenCalledOnce();
    });
  });
});
