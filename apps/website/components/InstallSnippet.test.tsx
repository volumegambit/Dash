import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstallSnippet } from './InstallSnippet';

const INSTALL_COMMAND = 'curl -fsSL dashsquad.ai/install.sh | sh';

// happy-dom replaces navigator.clipboard with a managed stub after render().
// The only reliable way to intercept writeText in this environment is to
// assign the mock directly onto the post-render clipboard instance.
function mockWriteText() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator.clipboard, 'writeText', {
    value: writeText,
    writable: true,
    configurable: true,
  });
  return writeText;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('InstallSnippet', () => {
  it('renders the install command with a $ prompt', () => {
    render(<InstallSnippet />);
    expect(screen.getByText('$', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText(INSTALL_COMMAND)).toBeInTheDocument();
  });

  it('renders a Copy button by default', () => {
    render(<InstallSnippet />);
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });

  it('writes the install command to the clipboard when Copy is clicked', async () => {
    const user = userEvent.setup();
    render(<InstallSnippet />);
    const writeText = mockWriteText();

    await user.click(screen.getByRole('button', { name: /copy/i }));

    expect(writeText).toHaveBeenCalledExactlyOnceWith(INSTALL_COMMAND);
  });

  it('shows a "Copied" confirmation after click, then reverts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<InstallSnippet />);
    mockWriteText();

    await user.click(screen.getByRole('button', { name: /copy/i }));
    expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();

    await act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });
});
