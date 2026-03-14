import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { SetupWizard } from './SetupWizard.js';

describe('SetupWizard', () => {
  const noop = () => {};

  describe('initial step rendering', () => {
    it('shows welcome step when needsSetup=true', () => {
      render(
        <SetupWizard needsSetup={true} needsUnlock={false} needsApiKey={true} onComplete={noop} />,
      );
      expect(screen.getByText('Welcome to Mission Control')).toBeInTheDocument();
      expect(screen.getByText('Get Started')).toBeInTheDocument();
    });

    it('shows provider step when needsSetup=false, needsApiKey=true', () => {
      render(
        <SetupWizard needsSetup={false} needsUnlock={false} needsApiKey={true} onComplete={noop} />,
      );
      expect(screen.getByText('Choose Your AI Provider')).toBeInTheDocument();
    });

    it('shows password unlock step when needsUnlock=true', () => {
      render(
        <SetupWizard needsSetup={false} needsUnlock={true} needsApiKey={false} onComplete={noop} />,
      );
      expect(screen.getByText('Unlock Secrets')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
      // Should NOT show confirm field (this is unlock, not create)
      expect(screen.queryByPlaceholderText('Confirm password')).not.toBeInTheDocument();
    });

    it('shows done step when both are false', () => {
      render(
        <SetupWizard
          needsSetup={false}
          needsUnlock={false}
          needsApiKey={false}
          onComplete={noop}
        />,
      );
      expect(screen.getByText("You're All Set!")).toBeInTheDocument();
      expect(screen.getByText('Go to Dashboard')).toBeInTheDocument();
    });
  });

  describe('navigation', () => {
    it('navigates from welcome to password on "Get Started" click', async () => {
      const user = userEvent.setup();
      render(
        <SetupWizard needsSetup={true} needsUnlock={false} needsApiKey={true} onComplete={noop} />,
      );

      await user.click(screen.getByText('Get Started'));

      expect(screen.getByText('Create Encryption Password')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
    });

    it('navigates back from password to welcome', async () => {
      const user = userEvent.setup();
      render(
        <SetupWizard needsSetup={true} needsUnlock={false} needsApiKey={true} onComplete={noop} />,
      );

      await user.click(screen.getByText('Get Started'));
      expect(screen.getByText('Create Encryption Password')).toBeInTheDocument();

      await user.click(screen.getByText('Back'));
      expect(screen.getByText('Welcome to Mission Control')).toBeInTheDocument();
    });
  });

  describe('password step', () => {
    it('shows "Passwords do not match." when confirm does not match', async () => {
      const user = userEvent.setup();
      render(
        <SetupWizard needsSetup={true} needsUnlock={false} needsApiKey={true} onComplete={noop} />,
      );

      await user.click(screen.getByText('Get Started'));

      await user.type(screen.getByPlaceholderText('Password'), 'mypassword');
      await user.type(screen.getByPlaceholderText('Confirm password'), 'different');
      await user.click(screen.getByText('Create Password'));

      expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
      expect(mockApi.secretsSetup).not.toHaveBeenCalled();
    });

    it('calls secretsSetup on successful create and advances to provider', async () => {
      const user = userEvent.setup();
      render(
        <SetupWizard needsSetup={true} needsUnlock={false} needsApiKey={true} onComplete={noop} />,
      );

      await user.click(screen.getByText('Get Started'));

      await user.type(screen.getByPlaceholderText('Password'), 'mypassword');
      await user.type(screen.getByPlaceholderText('Confirm password'), 'mypassword');
      await user.click(screen.getByText('Create Password'));

      expect(mockApi.secretsSetup).toHaveBeenCalledWith('mypassword');
      await screen.findByText('Choose Your AI Provider');
    });
  });

  describe('unlock step', () => {
    it('calls secretsUnlock (not secretsSetup) on unlock submit', async () => {
      const user = userEvent.setup();
      render(
        <SetupWizard needsSetup={false} needsUnlock={true} needsApiKey={false} onComplete={noop} />,
      );

      await user.type(screen.getByPlaceholderText('Password'), 'mypassword');
      await user.click(screen.getByText('Unlock'));

      expect(mockApi.secretsUnlock).toHaveBeenCalledWith('mypassword');
      expect(mockApi.secretsSetup).not.toHaveBeenCalled();
      await screen.findByText("You're All Set!");
    });

    it('does not show Back button when unlocking', () => {
      render(
        <SetupWizard needsSetup={false} needsUnlock={true} needsApiKey={false} onComplete={noop} />,
      );
      expect(screen.queryByText('Back')).not.toBeInTheDocument();
    });
  });

  describe('provider step', () => {
    it('shows "Claude by Anthropic" and "Continue with Claude by Anthropic" by default', () => {
      render(
        <SetupWizard needsSetup={false} needsUnlock={false} needsApiKey={true} onComplete={noop} />,
      );

      expect(screen.getByText('Claude by Anthropic')).toBeInTheDocument();
      expect(screen.getByText(/Continue with Claude by Anthropic/)).toBeInTheDocument();
    });
  });

  describe('api key step', () => {
    it('calls secretsSet with anthropic-api-key:default on save', async () => {
      const user = userEvent.setup();
      render(
        <SetupWizard needsSetup={false} needsUnlock={false} needsApiKey={true} onComplete={noop} />,
      );

      // Navigate from provider to api-key step
      await user.click(screen.getByText(/Continue with Claude by Anthropic/));
      expect(screen.getByText('Connect to Claude')).toBeInTheDocument();

      await user.type(screen.getByPlaceholderText('sk-ant-...'), 'sk-ant-test-key-123');
      await user.click(screen.getByText('Save API Key'));

      expect(mockApi.secretsSet).toHaveBeenCalledWith(
        'anthropic-api-key:default',
        'sk-ant-test-key-123',
      );
      await screen.findByText("You're All Set!");
    });

    it('calls openExternal with console URL when console link clicked', async () => {
      const user = userEvent.setup();
      render(
        <SetupWizard needsSetup={false} needsUnlock={false} needsApiKey={true} onComplete={noop} />,
      );

      // Navigate from provider to api-key step
      await user.click(screen.getByText(/Continue with Claude by Anthropic/));

      await user.click(screen.getByText('console.anthropic.com'));

      expect(mockApi.openExternal).toHaveBeenCalledWith('https://console.anthropic.com');
    });
  });

  describe('done step', () => {
    it('calls onComplete when "Go to Dashboard" clicked', async () => {
      const user = userEvent.setup();
      const onComplete = vi.fn();
      render(
        <SetupWizard
          needsSetup={false}
          needsUnlock={false}
          needsApiKey={false}
          onComplete={onComplete}
        />,
      );

      await user.click(screen.getByText('Go to Dashboard'));

      expect(onComplete).toHaveBeenCalledOnce();
    });
  });
});
