import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { useDeploymentsStore } from '../stores/deployments.js';

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ component: opts.component }),
  useNavigate: () => mockNavigate,
}));

const { DeployWizard } = await import('./deploy.js');

describe('DeployWizard', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    useDeploymentsStore.setState({
      deployments: [],
      loading: false,
      error: null,
      logLines: {},
    });
  });

  it('renders agent step initially', () => {
    render(<DeployWizard />);
    expect(screen.getByText('Deploy Agent')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('my-agent')).toBeInTheDocument();
  });

  it('Next button is disabled when agent name is empty', () => {
    render(<DeployWizard />);
    const nextBtn = screen.getByRole('button', { name: /next/i });
    expect(nextBtn).toBeDisabled();
  });

  it('Next button is enabled when agent name is provided', async () => {
    const user = userEvent.setup();
    render(<DeployWizard />);

    await user.type(screen.getByPlaceholderText('my-agent'), 'test-agent');
    const nextBtn = screen.getByRole('button', { name: /next/i });
    expect(nextBtn).toBeEnabled();
  });

  it('navigates to channels step on Next click', async () => {
    const user = userEvent.setup();
    render(<DeployWizard />);

    await user.type(screen.getByPlaceholderText('my-agent'), 'test-agent');
    await user.click(screen.getByRole('button', { name: /next/i }));

    expect(screen.getByText('Mission Control Chat')).toBeInTheDocument();
    expect(screen.getByText('Telegram Bot')).toBeInTheDocument();
  });

  it('navigates back from channels to agent step', async () => {
    const user = userEvent.setup();
    render(<DeployWizard />);

    await user.type(screen.getByPlaceholderText('my-agent'), 'test-agent');
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByText('Mission Control Chat')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByPlaceholderText('my-agent')).toBeInTheDocument();
  });

  it('tool toggle adds and removes a tool', async () => {
    const user = userEvent.setup();
    render(<DeployWizard />);

    const readFileCheckbox = screen.getByRole('checkbox', { name: /read file/i });
    expect(readFileCheckbox).not.toBeChecked();

    await user.click(readFileCheckbox);
    expect(readFileCheckbox).toBeChecked();

    await user.click(readFileCheckbox);
    expect(readFileCheckbox).not.toBeChecked();
  });

  it('review step shows correct summary', async () => {
    const user = userEvent.setup();
    render(<DeployWizard />);

    // Fill in agent config
    await user.type(screen.getByPlaceholderText('my-agent'), 'my-cool-agent');

    // Advance to channels
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByText('Mission Control Chat')).toBeInTheDocument();

    // Advance to review
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Verify review content
    expect(screen.getByText('my-cool-agent')).toBeInTheDocument();
    expect(screen.getByText('Claude Sonnet 4')).toBeInTheDocument();
  });

  it('deploy calls deploymentsDeployWithConfig with correct options', async () => {
    const user = userEvent.setup();
    render(<DeployWizard />);

    // Fill in agent name
    await user.type(screen.getByPlaceholderText('my-agent'), 'deploy-test');

    // Advance to channels
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Advance to review
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Click Deploy
    await user.click(screen.getByRole('button', { name: /deploy/i }));

    expect(mockApi.deploymentsDeployWithConfig).toHaveBeenCalledWith({
      name: 'deploy-test',
      model: 'anthropic/claude-sonnet-4-20250514',
      fallbackModels: undefined,
      systemPrompt: '',
      tools: [],
      enableTelegram: false,
    });
  });

  it('telegram token missing shows warning', async () => {
    const user = userEvent.setup();
    render(<DeployWizard />);

    // Fill in agent name and advance to channels
    await user.type(screen.getByPlaceholderText('my-agent'), 'test-agent');
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Click the telegram toggle button
    const telegramToggle = screen.getByRole('button', { name: /toggle telegram/i });
    await user.click(telegramToggle);

    // Check for the warning message
    expect(await screen.findByText(/telegram-bot-token not found/i)).toBeInTheDocument();
  });
});
