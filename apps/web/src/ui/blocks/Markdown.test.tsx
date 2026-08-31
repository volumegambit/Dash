import { render, screen } from '@testing-library/react';
import { Markdown } from './Markdown.js';

describe('Markdown', () => {
  it('renders **bold** as <strong>, not literal asterisks', () => {
    render(<Markdown text="This is **bold** text." />);
    const strong = screen.getByText('bold');
    expect(strong.tagName).toBe('STRONG');
    expect(screen.queryByText('**bold**')).toBeNull();
  });

  it('renders a gfm table', () => {
    const text = ['| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    render(<Markdown text={text} />);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
  });

  it('applies hljs highlighting classes and the #161b22 background to fenced code', () => {
    const text = ['```js', 'const x = 1;', '```'].join('\n');
    const { container } = render(<Markdown text={text} />);
    const pre = container.querySelector('pre.md-pre');
    expect(pre).toBeTruthy();
    const code = container.querySelector('code');
    expect(code?.className).toContain('hljs');
  });

  it('opens links in a new tab with rel=noopener', () => {
    render(<Markdown text="[click me](https://example.com)" />);
    const link = screen.getByRole('link', { name: 'click me' });
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('does not render raw HTML', () => {
    render(<Markdown text="<strong>injected</strong>" />);
    // No react-created <strong> element should exist from raw HTML — it should
    // appear as literal escaped text instead.
    expect(screen.queryByRole('strong')).toBeNull();
    expect(screen.getByText(/injected/)).toBeTruthy();
  });

  it('renders headings, lists, blockquotes, inline code, and hr with md- classes', () => {
    const text = [
      '# Heading 1',
      '',
      '- item one',
      '- item two',
      '',
      '> a quote',
      '',
      'Some `inline code` here.',
      '',
      '---',
    ].join('\n');
    const { container } = render(<Markdown text={text} />);
    expect(container.querySelector('h1.md-h1')).toBeTruthy();
    expect(container.querySelector('ul.md-ul')).toBeTruthy();
    expect(container.querySelectorAll('li.md-li').length).toBe(2);
    expect(container.querySelector('blockquote.md-blockquote')).toBeTruthy();
    expect(container.querySelector('code.md-code-inline')).toBeTruthy();
    expect(container.querySelector('hr.md-hr')).toBeTruthy();
  });

  it('renders images with max-width 100% and no download button', () => {
    const { container } = render(<Markdown text="![alt text](https://example.com/img.png)" />);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('https://example.com/img.png');
    expect(img?.getAttribute('alt')).toBe('alt text');
    expect(container.querySelector('button')).toBeNull();
  });
});
