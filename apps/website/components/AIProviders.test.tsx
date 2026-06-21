import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AIProviders } from './AIProviders';

describe('AIProviders', () => {
  it('lists OpenRouter alongside the direct providers', () => {
    render(<AIProviders />);
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('Google Gemini')).toBeInTheDocument();
    expect(screen.getByText('OpenRouter')).toBeInTheDocument();
  });

  it('describes OpenRouter as a one-key gateway to many models', () => {
    render(<AIProviders />);
    expect(screen.getByText(/hundreds of models/i)).toBeInTheDocument();
  });

  it('frames OpenRouter as reaching more models via a single key in the intro copy', () => {
    render(<AIProviders />);
    expect(screen.getByText(/single OpenRouter key/i)).toBeInTheDocument();
  });
});
