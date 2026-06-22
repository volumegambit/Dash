import '@testing-library/jest-dom/vitest';
import type { PluginRecord } from '@dash/management';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PluginTrustModal } from './PluginTrustModal.js';

function plugin(patch: Partial<PluginRecord> = {}): PluginRecord {
  return {
    name: 'acme-tools',
    status: 'loaded',
    enabled: true,
    trusted: false,
    activated: ['skills'],
    noop: ['mcp', 'hooks'],
    version: '1.2.3',
    displayName: 'Acme Tools',
    ...patch,
  };
}

describe('PluginTrustModal', () => {
  const defaultProps = {
    open: true,
    plugin: plugin(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  it('returns null when open is false', () => {
    const { container } = render(<PluginTrustModal {...defaultProps} open={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('returns null when plugin is null', () => {
    const { container } = render(<PluginTrustModal {...defaultProps} plugin={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the display name and version', () => {
    render(<PluginTrustModal {...defaultProps} />);
    expect(screen.getByText('Acme Tools')).toBeInTheDocument();
    expect(screen.getByText('v1.2.3')).toBeInTheDocument();
  });

  it('falls back to name when displayName is absent', () => {
    render(<PluginTrustModal {...defaultProps} plugin={plugin({ displayName: undefined })} />);
    expect(screen.getByText('acme-tools')).toBeInTheDocument();
  });

  it('lists code components from the union of activated and noop', () => {
    // activated has only the non-code kind 'skills'; the code kinds live in noop.
    render(
      <PluginTrustModal
        {...defaultProps}
        plugin={plugin({ activated: ['skills'], noop: ['mcp', 'hooks'] })}
      />,
    );
    expect(screen.getByText('mcp')).toBeInTheDocument();
    expect(screen.getByText('hooks')).toBeInTheDocument();
    // 'skills' is not a code kind — it should not appear in the activate list.
    expect(screen.queryByText('skills')).not.toBeInTheDocument();
  });

  it('deduplicates code components present in both activated and noop', () => {
    render(
      <PluginTrustModal
        {...defaultProps}
        plugin={plugin({ activated: ['mcp'], noop: ['mcp', 'bin'] })}
      />,
    );
    expect(screen.getAllByText('mcp')).toHaveLength(1);
    expect(screen.getByText('bin')).toBeInTheDocument();
  });

  it('shows the no-code-components message when there are none', () => {
    render(
      <PluginTrustModal
        {...defaultProps}
        plugin={plugin({ activated: ['skills'], noop: ['agents'] })}
      />,
    );
    expect(screen.getByText('No code components to activate.')).toBeInTheDocument();
  });

  it('renders the red warning text', () => {
    render(<PluginTrustModal {...defaultProps} />);
    const warning = screen.getByText('This code will run on your machine.');
    expect(warning).toBeInTheDocument();
    expect(warning.className).toContain('text-red-400');
  });

  it('disables Trust Plugin with a tooltip when the plugin is not enabled', () => {
    render(<PluginTrustModal {...defaultProps} plugin={plugin({ enabled: false })} />);
    const button = screen.getByRole('button', { name: 'Trust Plugin' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Enable the plugin first');
  });

  it('enables Trust Plugin when the plugin is enabled', () => {
    render(<PluginTrustModal {...defaultProps} plugin={plugin({ enabled: true })} />);
    expect(screen.getByRole('button', { name: 'Trust Plugin' })).toBeEnabled();
  });

  it('calls onConfirm with the plugin name when Trust is clicked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<PluginTrustModal {...defaultProps} onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Trust Plugin' }));
    expect(onConfirm).toHaveBeenCalledWith('acme-tools');
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<PluginTrustModal {...defaultProps} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
