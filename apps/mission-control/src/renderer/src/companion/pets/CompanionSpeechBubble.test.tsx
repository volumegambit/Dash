import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { CompanionSpeechBubble } from './CompanionSpeechBubble.js';
import { MOOD_COLLARS } from './types.js';

test('renders the text when visible with a polite live region', () => {
  render(<CompanionSpeechBubble text="Edit: auth.ts" mood="working" visible />);
  const bubble = screen.getByRole('status');
  expect(bubble).toHaveTextContent('Edit: auth.ts');
  expect(bubble.getAttribute('aria-live')).toBe('polite');
});

test('renders nothing when not visible', () => {
  const { container } = render(
    <CompanionSpeechBubble text="Edit: auth.ts" mood="working" visible={false} />,
  );
  expect(container.firstChild).toBeNull();
});

test('renders nothing for empty or whitespace-only text', () => {
  const { container: a } = render(<CompanionSpeechBubble text="" mood="working" visible />);
  expect(a.firstChild).toBeNull();
  const { container: b } = render(<CompanionSpeechBubble text="   " mood="working" visible />);
  expect(b.firstChild).toBeNull();
});

/** jsdom normalizes hex colors to `rgb(...)`; convert for comparison. */
function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

test('tints the bubble with the mood hue', () => {
  render(<CompanionSpeechBubble text="boom" mood="error" visible />);
  const bubble = screen.getByRole('status');
  // The error collar hue drives the border color.
  expect(bubble.style.borderColor).toBe(hexToRgb(MOOD_COLLARS.error));
});

test('truncates long text with ellipsis styling', () => {
  const long = 'x'.repeat(200);
  render(<CompanionSpeechBubble text={long} mood="working" visible />);
  const bubble = screen.getByRole('status');
  expect(bubble.style.textOverflow).toBe('ellipsis');
  expect(bubble.style.overflow).toBe('hidden');
});
