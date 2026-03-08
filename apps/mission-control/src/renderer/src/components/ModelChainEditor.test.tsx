import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ModelChainEditor } from './ModelChainEditor.js';
import type { ModelOption } from './deploy-options.js';

const models: ModelOption[] = [
  { value: 'anthropic/claude-sonnet-4-20250514', label: 'Claude Sonnet 4', provider: 'anthropic', secretKey: 'anthropic-api-key' },
  { value: 'anthropic/claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic', secretKey: 'anthropic-api-key' },
  { value: 'openai/gpt-4o', label: 'GPT-4o', provider: 'openai', secretKey: 'openai-api-key' },
];

describe('ModelChainEditor', () => {
  it('renders primary model selector', () => {
    const onChange = vi.fn();
    render(
      <ModelChainEditor
        model="anthropic/claude-sonnet-4-20250514"
        fallbackModels={[]}
        availableModels={models}
        onChange={onChange}
      />,
    );
    expect(screen.getByDisplayValue('Claude Sonnet 4')).toBeInTheDocument();
  });

  it('calls onChange when primary model changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ModelChainEditor
        model="anthropic/claude-sonnet-4-20250514"
        fallbackModels={[]}
        availableModels={models}
        onChange={onChange}
      />,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: /primary model/i }), 'openai/gpt-4o');
    expect(onChange).toHaveBeenCalledWith('openai/gpt-4o', []);
  });

  it('renders fallback model rows', () => {
    const onChange = vi.fn();
    render(
      <ModelChainEditor
        model="anthropic/claude-sonnet-4-20250514"
        fallbackModels={['openai/gpt-4o']}
        availableModels={models}
        onChange={onChange}
      />,
    );
    expect(screen.getByDisplayValue('GPT-4o')).toBeInTheDocument();
  });

  it('adds a fallback model on "Add fallback" click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ModelChainEditor
        model="anthropic/claude-sonnet-4-20250514"
        fallbackModels={[]}
        availableModels={models}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByText('+ Add fallback'));
    expect(onChange).toHaveBeenCalled();
    const [, fallbacks] = onChange.mock.calls[0] as [string, string[]];
    expect(fallbacks.length).toBe(1);
  });

  it('removes a fallback model on remove click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ModelChainEditor
        model="anthropic/claude-sonnet-4-20250514"
        fallbackModels={['openai/gpt-4o']}
        availableModels={models}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: /remove fallback/i }));
    expect(onChange).toHaveBeenCalledWith('anthropic/claude-sonnet-4-20250514', []);
  });

  it('shows empty state when no models available', () => {
    const onChange = vi.fn();
    render(
      <ModelChainEditor
        model=""
        fallbackModels={[]}
        availableModels={[]}
        onChange={onChange}
      />,
    );
    expect(screen.getByText(/add api keys in settings/i)).toBeInTheDocument();
  });
});
