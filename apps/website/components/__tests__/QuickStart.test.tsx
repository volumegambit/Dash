import { render, screen } from '@testing-library/react';
import { QuickStart } from '../QuickStart';

describe('QuickStart', () => {
  it('renders the section heading', () => {
    render(<QuickStart />);
    expect(screen.getByRole('heading', { name: /get started/i })).toBeInTheDocument();
  });

  it('renders all 3 install steps', () => {
    render(<QuickStart />);
    expect(screen.getByText(/git clone/)).toBeInTheDocument();
    expect(screen.getByText(/npm install/)).toBeInTheDocument();
    expect(screen.getByText(/npm run dev/)).toBeInTheDocument();
  });

  it('renders a link to full setup guide', () => {
    render(<QuickStart />);
    const link = screen.getByRole('link', { name: /full setup guide/i });
    expect(link).toHaveAttribute('href', 'https://docs.dashsquad.ai');
  });
});
