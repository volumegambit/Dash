import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CompanionStack } from './CompanionStack.js';
import type { CompanionSession } from './types.js';

function sess(id: string, status: CompanionSession['status'], preview: string): CompanionSession {
  return {
    conversationId: id,
    agentId: 'a',
    agentName: 'Ops Bot',
    title: `Title ${id}`,
    status,
    preview,
    since: 0,
  };
}

const noop = () => {};

describe('CompanionStack', () => {
  it('renders only the tree when collapsed', () => {
    const html = renderToStaticMarkup(
      <CompanionStack
        sessions={[sess('1', 'done', 'Done!')]}
        expanded={false}
        now={0}
        onToggle={noop}
        onOpen={noop}
      />,
    );
    expect(html).toContain('<svg');
    expect(html).not.toContain('Title 1');
  });

  it('renders cards and an overflow pill when expanded', () => {
    const sessions = [
      sess('1', 'needs', 'Approve?'),
      sess('2', 'working', 'Running'),
      sess('3', 'done', 'A'),
      sess('4', 'done', 'B'),
      sess('5', 'done', 'C'),
    ];
    const html = renderToStaticMarkup(
      <CompanionStack sessions={sessions} expanded={true} now={0} onToggle={noop} onOpen={noop} />,
    );
    expect(html).toContain('Title 1');
    expect(html).toContain('Approve?');
    expect(html).toContain('+1 more');
  });
});
