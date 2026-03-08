import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { AiProviders } from './connections.js';

describe('AiProviders page', () => {
  beforeEach(() => {
    // Default: anthropic connected, others not
    mockApi.secretsGet.mockImplementation((key: string) =>
      Promise.resolve(key === 'anthropic-api-key' ? 'sk-ant-abc123secretkey' : null),
    );
  });

  it('shows connected status indicator for providers with a key', async () => {
    render(<AiProviders />);
    await waitFor(() => {
      expect(screen.getByText('Claude by Anthropic')).toBeInTheDocument();
    });
    // Connected provider shows masked key, not description
    expect(
      screen.queryByText('A powerful AI assistant known for being helpful, harmless, and honest.'),
    ).not.toBeInTheDocument();
  });

  it('shows Connect button for providers without a key', async () => {
    render(<AiProviders />);
    await waitFor(() => {
      const connectButtons = screen.getAllByText('Connect');
      expect(connectButtons).toHaveLength(2); // openai + google
    });
  });

  it('opens modal when Connect is clicked', async () => {
    const user = userEvent.setup();
    render(<AiProviders />);
    await waitFor(() => screen.getAllByText('Connect'));
    await user.click(screen.getAllByText('Connect')[0]);
    expect(screen.getByText('Connect to OpenAI')).toBeInTheDocument();
  });

  it('shows Update and Disconnect buttons for connected provider', async () => {
    render(<AiProviders />);
    await waitFor(() => {
      expect(screen.getByText('Update')).toBeInTheDocument();
      expect(screen.getByText('Disconnect')).toBeInTheDocument();
    });
  });

  it('shows inline confirm when Disconnect is clicked', async () => {
    const user = userEvent.setup();
    render(<AiProviders />);
    await waitFor(() => screen.getByText('Disconnect'));
    await user.click(screen.getByText('Disconnect'));
    expect(screen.getByText('Remove key?')).toBeInTheDocument();
    expect(screen.getByText('Yes, remove')).toBeInTheDocument();
  });

  it('calls secretsDelete and refreshes when disconnect confirmed', async () => {
    const user = userEvent.setup();
    mockApi.secretsDelete.mockResolvedValue(undefined);
    render(<AiProviders />);
    await waitFor(() => screen.getByText('Disconnect'));
    await user.click(screen.getByText('Disconnect'));
    await user.click(screen.getByText('Yes, remove'));
    expect(mockApi.secretsDelete).toHaveBeenCalledWith('anthropic-api-key');
  });
});
