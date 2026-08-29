import { render, screen } from '@testing-library/react';
import App from './App.js';

describe('App', () => {
  it('renders the heading', () => {
    render(<App />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Dash');
  });
});
