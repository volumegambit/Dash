import { render, screen } from '@testing-library/react';
import { Community } from '../Community';

describe('Community', () => {
  it('renders the heading', () => {
    render(<Community />);
    expect(screen.getByRole('heading', { name: /join the dash community/i })).toBeInTheDocument();
  });

  it('renders Discord link', () => {
    render(<Community />);
    const link = screen.getByRole('link', { name: /join discord/i });
    expect(link).toBeInTheDocument();
  });
});
