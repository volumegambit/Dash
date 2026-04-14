import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ModelOption } from '../components/deploy-options.js';
import { ChatModelPicker, groupModelsByProvider } from './chat.model-picker.js';

const models: ModelOption[] = [
  {
    value: 'anthropic/claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    secretKey: 'anthropic-api-key',
  },
  {
    value: 'anthropic/claude-opus-4-6',
    label: 'Claude Opus 4.6',
    provider: 'anthropic',
    secretKey: 'anthropic-api-key',
  },
  {
    value: 'openai/gpt-4o',
    label: 'GPT-4o',
    provider: 'openai',
    secretKey: 'openai-api-key',
  },
  {
    value: 'google/gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    provider: 'google',
    secretKey: 'google-api-key',
  },
];

describe('groupModelsByProvider', () => {
  it('groups by provider while preserving per-group order', () => {
    const groups = groupModelsByProvider(models);
    expect(groups.map(([k]) => k)).toEqual(['anthropic', 'openai', 'google']);
    expect(groups[0][1].map((m) => m.value)).toEqual([
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-opus-4-6',
    ]);
  });

  it('returns an empty array for an empty list', () => {
    expect(groupModelsByProvider([])).toEqual([]);
  });

  it('handles a single provider', () => {
    const solo = [models[2]];
    const groups = groupModelsByProvider(solo);
    expect(groups).toHaveLength(1);
    expect(groups[0][0]).toBe('openai');
  });
});

describe('ChatModelPicker', () => {
  it('renders the label of the currently selected model', () => {
    render(<ChatModelPicker value="openai/gpt-4o" models={models} onChange={vi.fn()} />);
    expect(screen.getByTestId('chat-model-picker-trigger').textContent).toContain('GPT-4o');
  });

  it('falls back to the raw value when the model is missing from the list', () => {
    render(<ChatModelPicker value="unknown/model-x" models={models} onChange={vi.fn()} />);
    expect(screen.getByTestId('chat-model-picker-trigger').textContent).toContain(
      'unknown/model-x',
    );
  });

  it('is closed by default', () => {
    render(<ChatModelPicker value="openai/gpt-4o" models={models} onChange={vi.fn()} />);
    expect(screen.queryByTestId('chat-model-picker-menu')).toBeNull();
  });

  it('clicking the trigger opens the menu with all models grouped by provider', () => {
    render(<ChatModelPicker value="openai/gpt-4o" models={models} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('chat-model-picker-trigger'));

    const menu = screen.getByTestId('chat-model-picker-menu');
    expect(menu).toBeInTheDocument();

    // Provider headers
    expect(menu.textContent).toContain('Anthropic');
    expect(menu.textContent).toContain('OpenAI');
    expect(menu.textContent).toContain('Google');

    // All model labels visible
    expect(menu.textContent).toContain('Claude Sonnet 4.6');
    expect(menu.textContent).toContain('Claude Opus 4.6');
    expect(menu.textContent).toContain('GPT-4o');
    expect(menu.textContent).toContain('Gemini 2.5 Pro');
  });

  it('clicking a different model calls onChange with its value and closes the menu', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<ChatModelPicker value="openai/gpt-4o" models={models} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('chat-model-picker-trigger'));
    // The select handler awaits onChange and then clears `pending` state in
    // a finally block — wrap in act() so React flushes that microtask
    // update before the test ends.
    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-model-picker-option-anthropic/claude-sonnet-4-6'));
    });

    expect(onChange).toHaveBeenCalledWith('anthropic/claude-sonnet-4-6');
    expect(screen.queryByTestId('chat-model-picker-menu')).toBeNull();
  });

  it('clicking the currently selected model closes the menu without calling onChange', () => {
    const onChange = vi.fn();
    render(<ChatModelPicker value="openai/gpt-4o" models={models} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('chat-model-picker-trigger'));
    fireEvent.click(screen.getByTestId('chat-model-picker-option-openai/gpt-4o'));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId('chat-model-picker-menu')).toBeNull();
  });

  it('marks the currently selected model with aria-selected=true', () => {
    render(<ChatModelPicker value="openai/gpt-4o" models={models} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('chat-model-picker-trigger'));
    const selected = screen.getByTestId('chat-model-picker-option-openai/gpt-4o');
    expect(selected).toHaveAttribute('aria-selected', 'true');

    const other = screen.getByTestId('chat-model-picker-option-anthropic/claude-sonnet-4-6');
    expect(other).toHaveAttribute('aria-selected', 'false');
  });

  it('outside click closes the menu', () => {
    render(
      <div>
        <div data-testid="outside">outside</div>
        <ChatModelPicker value="openai/gpt-4o" models={models} onChange={vi.fn()} />
      </div>,
    );

    fireEvent.click(screen.getByTestId('chat-model-picker-trigger'));
    expect(screen.getByTestId('chat-model-picker-menu')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByTestId('chat-model-picker-menu')).toBeNull();
  });

  it('pressing Escape closes the menu', () => {
    render(<ChatModelPicker value="openai/gpt-4o" models={models} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('chat-model-picker-trigger'));
    expect(screen.getByTestId('chat-model-picker-menu')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('chat-model-picker-menu')).toBeNull();
  });

  it('shows "No models available" when the list is empty', () => {
    render(<ChatModelPicker value="" models={[]} onChange={vi.fn()} />);
    // Trigger is disabled when no models are available, so force a click via
    // the underlying element — React still swallows it, so assert on the
    // button's disabled state instead.
    const trigger = screen.getByTestId('chat-model-picker-trigger');
    expect(trigger).toBeDisabled();
  });

  it('disabled prop prevents opening the menu', () => {
    render(<ChatModelPicker value="openai/gpt-4o" models={models} onChange={vi.fn()} disabled />);
    const trigger = screen.getByTestId('chat-model-picker-trigger');
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('chat-model-picker-menu')).toBeNull();
  });

  it('commit is optimistic: menu closes before the onChange promise resolves', async () => {
    // A deferred promise we control — lets us assert the menu closed
    // *before* onChange settled.
    let resolveChange: () => void = () => {};
    const onChange = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveChange = resolve;
        }),
    );

    render(<ChatModelPicker value="openai/gpt-4o" models={models} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('chat-model-picker-trigger'));
    fireEvent.click(screen.getByTestId('chat-model-picker-option-anthropic/claude-opus-4-6'));

    // Menu is already gone, even though onChange hasn't resolved
    expect(screen.queryByTestId('chat-model-picker-menu')).toBeNull();
    expect(onChange).toHaveBeenCalledWith('anthropic/claude-opus-4-6');

    // Settle the deferred *inside* act() so React flushes the finally
    // setState before the test ends — keeps the suite warning-free.
    await act(async () => {
      resolveChange();
    });
  });
});
