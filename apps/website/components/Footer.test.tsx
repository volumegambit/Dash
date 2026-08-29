import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Footer } from './Footer';

describe('Footer', () => {
  it('links to the privacy policy', () => {
    render(<Footer />);
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      '/privacy_policy/',
    );
  });

  it('links to the terms of service', () => {
    render(<Footer />);
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute(
      'href',
      '/terms_of_service/',
    );
  });

  it('opens external links in a new tab', () => {
    render(<Footer />);
    const github = screen.getByRole('link', { name: 'Source on GitHub' });
    expect(github).toHaveAttribute('target', '_blank');
    expect(github).toHaveAttribute('rel', 'noreferrer');
  });

  it('keeps legal links in the same tab', () => {
    render(<Footer />);
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).not.toHaveAttribute('target');
  });
});
