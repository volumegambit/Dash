import { render, screen } from '@testing-library/react';
import { Features } from '../Features';

describe('Features', () => {
  it('renders all 6 feature titles', () => {
    render(<Features />);
    expect(screen.getByText('Your agents, your LLMs')).toBeInTheDocument();
    expect(screen.getByText('Mission Control')).toBeInTheDocument();
    expect(screen.getByText('CLI & automation')).toBeInTheDocument();
    expect(screen.getByText('Runs anywhere')).toBeInTheDocument();
    expect(screen.getByText('Multi-channel')).toBeInTheDocument();
    expect(screen.getByText('Safe by default')).toBeInTheDocument();
  });
});
