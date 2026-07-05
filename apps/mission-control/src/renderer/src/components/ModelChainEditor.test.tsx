import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ModelChainEditor } from './ModelChainEditor.js';
import type { ModelOption } from './deploy-options.js';

const models: ModelOption[] = [
  {
    value: 'anthropic/claude-sonnet-4-20250514',
    label: 'Claude Sonnet 4',
    provider: 'anthropic',
    secretKey: 'anthropic-api-key',
  },
  {
    value: 'anthropic/claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    provider: 'anthropic',
    secretKey: 'anthropic-api-key',
  },
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
    await user.selectOptions(
      screen.getByRole('combobox', { name: /primary model/i }),
      'openai/gpt-4o',
    );
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
      <ModelChainEditor model="" fallbackModels={[]} availableModels={[]} onChange={onChange} />,
    );
    expect(screen.getByText(/add api keys in settings/i)).toBeInTheDocument();
  });

  it('renders every provider when allowedProviders is unset', () => {
    const onChange = vi.fn();
    render(
      <ModelChainEditor
        model="anthropic/claude-sonnet-4-20250514"
        fallbackModels={[]}
        availableModels={models}
        onChange={onChange}
      />,
    );
    // Both provider optgroups present; no filtering without the prop.
    expect(screen.getByRole('group', { name: 'Anthropic' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'OpenAI' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'GPT-4o' })).toBeInTheDocument();
  });

  it('renders only allowed-provider options when allowedProviders is set', () => {
    const onChange = vi.fn();
    render(
      <ModelChainEditor
        model="anthropic/claude-sonnet-4-20250514"
        fallbackModels={[]}
        availableModels={models}
        onChange={onChange}
        allowedProviders={['anthropic']}
      />,
    );
    // Anthropic optgroup + options stay.
    expect(screen.getByRole('group', { name: 'Anthropic' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Claude Sonnet 4' })).toBeInTheDocument();
    // OpenAI is filtered out entirely (not the selected value).
    expect(screen.queryByRole('group', { name: 'OpenAI' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'GPT-4o' })).not.toBeInTheDocument();
  });

  it('keeps a selected model from a disallowed provider visible, marked "(not allowed)"', () => {
    const onChange = vi.fn();
    // The primary model is an OpenAI model, but OpenAI is no longer allowed.
    // It must remain visible so the conflict is obvious, marked as not allowed,
    // rather than silently vanishing (which would reset the visible selection).
    render(
      <ModelChainEditor
        model="openai/gpt-4o"
        fallbackModels={[]}
        availableModels={models}
        onChange={onChange}
        allowedProviders={['anthropic']}
      />,
    );
    // The disallowed-but-selected option stays, suffixed.
    expect(screen.getByRole('option', { name: /GPT-4o \(not allowed\)/i })).toBeInTheDocument();
    // The select still shows it as the current value.
    expect(screen.getByDisplayValue(/GPT-4o \(not allowed\)/i)).toBeInTheDocument();
    // Other, unselected OpenAI models are still filtered out.
    expect(screen.getByRole('group', { name: 'Anthropic' })).toBeInTheDocument();
  });

  it('keeps a selected fallback from a disallowed provider visible, marked "(not allowed)"', () => {
    const onChange = vi.fn();
    render(
      <ModelChainEditor
        model="anthropic/claude-sonnet-4-20250514"
        fallbackModels={['openai/gpt-4o']}
        availableModels={models}
        onChange={onChange}
        allowedProviders={['anthropic']}
      />,
    );
    // The disallowed-but-selected fallback stays visible + marked. It appears
    // in both the fallback row's select and the primary select's option list.
    const marked = screen.getAllByRole('option', { name: /GPT-4o \(not allowed\)/i });
    expect(marked.length).toBeGreaterThan(0);
    // The fallback select shows it as the current value.
    expect(screen.getByDisplayValue(/GPT-4o \(not allowed\)/i)).toBeInTheDocument();
  });

  it('groups OpenRouter models under their own "OpenRouter" optgroup', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const withOpenRouter: ModelOption[] = [
      ...models,
      {
        value: 'openrouter/deepseek/deepseek-r1',
        label: 'DeepSeek: R1',
        provider: 'openrouter',
        secretKey: 'openrouter-api-key',
      },
    ];
    render(
      <ModelChainEditor
        model="anthropic/claude-sonnet-4-20250514"
        fallbackModels={[]}
        availableModels={withOpenRouter}
        onChange={onChange}
      />,
    );
    // <optgroup label="OpenRouter"> exposes role "group" with that accessible name.
    expect(screen.getByRole('group', { name: 'OpenRouter' })).toBeInTheDocument();
    // The namespaced value flows straight through onChange when selected.
    await user.selectOptions(
      screen.getByRole('combobox', { name: /primary model/i }),
      'openrouter/deepseek/deepseek-r1',
    );
    expect(onChange).toHaveBeenCalledWith('openrouter/deepseek/deepseek-r1', []);
  });
});
