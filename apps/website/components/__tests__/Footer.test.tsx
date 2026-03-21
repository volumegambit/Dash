import { render, screen } from '@testing-library/react';
import { Footer } from '../Footer';

describe('Footer', () => {
  it('renders copyright notice', () => {
    render(<Footer />);
    expect(screen.getByText(/2026 DashSquad/)).toBeInTheDocument();
  });

  it('renders GitHub, Docs, Discord links', () => {
    render(<Footer />);
    expect(screen.getByRole('link', { name: /github/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /docs/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /discord/i })).toBeInTheDocument();
  });
});
