import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../../../../vitest.setup.js';
import { useAgentsStore } from '../stores/agents.js';

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ component: opts.component }),
  useNavigate: () => mockNavigate,
}));

const { DeployWizard } = await import('./deploy.js');

describe('DeployWizard', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    useAgentsStore.setState({
      agents: [],
      loading: false,
      error: null,
    });
    // Provide credentials so the hint state is populated
    mockApi.credentialsList.mockResolvedValue([
      'anthropic-api-key:default',
      'openai-api-key:default',
      'google-api-key:default',
    ]);
    // The dropdown is now populated from the gateway. Seed a few
    // models so the wizard's model-required validation passes.
    mockApi.modelsList.mockResolvedValue({
      models: [
        {
          value: 'anthropic/claude-opus-4-5',
          label: 'Claude Opus 4.5',
          provider: 'anthropic',
        },
        {
          value: 'openai/gpt-5.4',
          label: 'GPT-5.4',
          provider: 'openai',
        },
        {
          value: 'google/gemini-2.5-pro',
          label: 'Gemini 2.5 Pro',
          provider: 'google',
        },
      ],
      source: 'live',
      errors: {},
      fetchedAt: '2026-04-13T00:00:00Z',
      supportedModelsReviewedAt: '2026-04-13',
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

  it('select all checks all tools and toggles them off', async () => {
    const user = userEvent.setup();
    render(<DeployWizard />);

    const selectAll = screen.getByRole('checkbox', { name: /select all/i });
    expect(selectAll).not.toBeChecked();

    await user.click(selectAll);
    const toolCheckboxes = screen.getAllByRole('checkbox').filter((cb) => cb !== selectAll);
    for (const cb of toolCheckboxes) {
      expect(cb).toBeChecked();
    }
    expect(selectAll).toBeChecked();

    await user.click(selectAll);
    for (const cb of toolCheckboxes) {
      expect(cb).not.toBeChecked();
    }
    expect(selectAll).not.toBeChecked();
  });

  it('review step shows correct summary', async () => {
    const user = userEvent.setup();
    render(<DeployWizard />);

    await user.type(screen.getByPlaceholderText('my-agent'), 'my-cool-agent');
    await user.click(screen.getByRole('button', { name: /next/i }));

    expect(screen.getByText('my-cool-agent')).toBeInTheDocument();
    expect(screen.getByText('Claude Opus 4.5')).toBeInTheDocument();
  });

  it('deploy calls agentsCreate with correct options', async () => {
    const user = userEvent.setup();
    render(<DeployWizard />);

    await user.type(screen.getByPlaceholderText('my-agent'), 'deploy-test');
    await user.click(screen.getByRole('button', { name: /next/i }));
    await user.click(screen.getByRole('button', { name: /deploy/i }));

    expect(mockApi.agentsCreate).toHaveBeenCalledWith({
      name: 'deploy-test',
      model: 'anthropic/claude-opus-4-5',
      fallbackModels: undefined,
      systemPrompt: '',
      tools: [],
      workspace: undefined,
    });
  });
});

describe('DeployWizard model validation', () => {
  beforeEach(() => {
    mockApi.credentialsList.mockResolvedValue([]);
    // Simulate the gateway's "no credentials configured" path: empty
    // models list (in production this would be the bootstrap fallback,
    // but the deploy wizard's "Next" button gates on availability).
    mockApi.modelsList.mockResolvedValue({
      models: [],
      source: 'bootstrap',
      errors: {},
      fetchedAt: '2026-04-13T00:00:00Z',
      supportedModelsReviewedAt: '2026-04-13',
    });
  });

  it('Next button is disabled when no model is available (no keys configured)', async () => {
    render(<DeployWizard />);
    const nameInput = screen.getByPlaceholderText('my-agent');
    await userEvent.type(nameInput, 'test-agent');
    const nextButton = screen.getByRole('button', { name: /next/i });
    expect(nextButton).toBeDisabled();
  });

  it('Next button is enabled when gateway returns models', async () => {
    mockApi.modelsList.mockResolvedValue({
      models: [
        { value: 'openai/gpt-5.4', label: 'GPT-5.4', provider: 'openai' },
      ],
      source: 'live',
      errors: {},
      fetchedAt: '2026-04-13T00:00:00Z',
      supportedModelsReviewedAt: '2026-04-13',
    });
    render(<DeployWizard />);
    const nameInput = screen.getByPlaceholderText('my-agent');
    await userEvent.type(nameInput, 'test-agent');
    const nextButton = await screen.findByRole('button', { name: /next/i });
    await waitFor(() => expect(nextButton).not.toBeDisabled());
  });
});
