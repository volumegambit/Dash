import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AIProviders } from './AIProviders';

describe('AIProviders', () => {
  it('lists the direct providers and their model families without invented provider icons', () => {
    const { container } = render(<AIProviders />);
    for (const name of ['Anthropic', 'OpenAI', 'Google', 'Moonshot AI']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    for (const models of ['Claude', 'GPT', 'Gemini', 'Kimi']) {
      expect(screen.getByText(models)).toBeInTheDocument();
    }
    expect(container.querySelector('svg, img')).not.toBeInTheDocument();
    expect(screen.queryByText('Recommended')).not.toBeInTheDocument();
  });

  it('describes OpenRouter without unsupported model counts or failover claims', () => {
    render(<AIProviders />);
    expect(screen.getByText('OpenRouter')).toBeInTheDocument();
    expect(screen.getByText(/wider model catalog with a single API key/i)).toBeInTheDocument();
    expect(screen.queryByText(/hundreds|failover/i)).not.toBeInTheDocument();
  });

  it('recognizes supported account sign-in alongside API keys', () => {
    render(<AIProviders />);
    expect(
      screen.getByText(/connect a supported account or bring an API key/i),
    ).toBeInTheDocument();
  });
});
