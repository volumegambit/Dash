import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CompanionTree } from './CompanionTree.js';

describe('CompanionTree', () => {
  it('renders an svg with the resting palette when there are no statuses', () => {
    const html = renderToStaticMarkup(<CompanionTree statuses={[]} />);
    expect(html).toContain('<svg');
    expect(html).toContain('#2f3a30');
    expect(html).not.toContain('#3da5d9');
  });

  it('colors the first leaf for a working session and adds the pulse class', () => {
    const html = renderToStaticMarkup(<CompanionTree statuses={['working']} />);
    expect(html).toContain('#3da5d9');
    expect(html).toContain('companion-pulse');
  });
});
