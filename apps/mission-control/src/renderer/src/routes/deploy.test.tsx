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

    await user.type(screen.getByPlaceholderText('my-agent'), 'my-cool-agent');
    await user.click(screen.getByRole('button', { name: /next/i }));

    expect(screen.getByText('my-cool-agent')).toBeInTheDocument();
    expect(screen.getByText('Claude Sonnet 4')).toBeInTheDocument();
  });

  it('deploy calls deploymentsDeployWithConfig with correct options', async () => {
    const user = userEvent.setup();
    render(<DeployWizard />);

    await user.type(screen.getByPlaceholderText('my-agent'), 'deploy-test');
    await user.click(screen.getByRole('button', { name: /next/i }));
    await user.click(screen.getByRole('button', { name: /deploy/i }));

    expect(mockApi.deploymentsDeployWithConfig).toHaveBeenCalledWith({
      name: 'deploy-test',
      model: 'anthropic/claude-sonnet-4-20250514',
      fallbackModels: undefined,
      systemPrompt: '',
      tools: [],
    });
  });
});
