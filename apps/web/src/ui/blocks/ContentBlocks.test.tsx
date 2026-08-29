import type { ConversationContent } from '@dash/mobile-contract';
import { render, screen } from '@testing-library/react';
import { ContentBlocks } from './ContentBlocks.js';

describe('ContentBlocks', () => {
  it('renders user content as text', () => {
    const content: ConversationContent = { type: 'user', text: 'Is the mobile connection ready?' };
    render(<ContentBlocks content={content} />);
    expect(screen.getByText('Is the mobile connection ready?')).toBeTruthy();
  });

  it('renders assistant text_delta events as paragraphs', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        { type: 'text_delta', text: 'Ready ' },
        { type: 'text_delta', text: 'from the gateway.' },
      ],
    };
    render(<ContentBlocks content={content} />);
    expect(screen.getByText('Ready from the gateway.')).toBeTruthy();
  });

  it('splits text on blank lines into separate paragraphs', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [{ type: 'text_delta', text: 'First paragraph.\n\nSecond paragraph.' }],
    };
    render(<ContentBlocks content={content} />);
    const paragraphs = screen.getAllByTestId('text-block');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].textContent).toBe('First paragraph.');
    expect(paragraphs[1].textContent).toBe('Second paragraph.');
  });

  it('renders a collapsed tool-use block with the tool name, nesting the tool-result inside it', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        { type: 'tool_use_start', id: 'call-1', name: 'bash', input: { command: 'ls' } },
        { type: 'tool_use_delta', partial_json: '{}' },
        { type: 'tool_result', id: 'call-1', name: 'bash', content: 'file1\nfile2' },
      ],
    };
    render(<ContentBlocks content={content} />);

    const toolBlock = screen.getByTestId('tool-use-block');
    expect(toolBlock.tagName).toBe('DETAILS');
    expect(toolBlock.hasAttribute('open')).toBe(false);
    expect(screen.getByText('bash')).toBeTruthy();

    const result = screen.getByTestId('tool-result');
    expect(toolBlock.contains(result)).toBe(true);
    expect(result.textContent).toBe('file1\nfile2');
  });

  it('renders an in-progress tool-use block when no tool-result has arrived yet', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [{ type: 'tool_use_start', id: 'call-1', name: 'bash', input: { command: 'ls' } }],
    };
    render(<ContentBlocks content={content} />);
    const toolBlock = screen.getByTestId('tool-use-block');
    expect(toolBlock.textContent).toContain('bash');
    expect(screen.queryByTestId('tool-result')).toBeNull();
  });

  it('renders a thinking block, muted/italic and collapsed by default', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [{ type: 'thinking_delta', text: 'Considering the options...' }],
    };
    render(<ContentBlocks content={content} />);
    const thinkingBlock = screen.getByTestId('thinking-block');
    expect(thinkingBlock.tagName).toBe('DETAILS');
    expect(thinkingBlock.hasAttribute('open')).toBe(false);
    expect(thinkingBlock.textContent).toContain('Considering the options...');
  });

  it('renders a fallback unknown-block for an unrecognized event type, without throwing', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [{ type: 'agent_spawned', name: 'worker-1' }],
    };
    expect(() => render(<ContentBlocks content={content} />)).not.toThrow();
    expect(screen.getByTestId('unknown-block')).toBeTruthy();
  });

  it('renders a fallback unknown-block for a malformed event (missing required field), without throwing', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [{ type: 'text_delta' } as unknown as { type: 'text_delta'; text: string }],
    };
    expect(() => render(<ContentBlocks content={content} />)).not.toThrow();
    expect(screen.getByTestId('unknown-block')).toBeTruthy();
  });

  it('renders a fallback unknown-block for entirely malformed content, without throwing', () => {
    const content = { type: 'bogus' } as unknown as ConversationContent;
    expect(() => render(<ContentBlocks content={content} />)).not.toThrow();
    expect(screen.getByTestId('unknown-block')).toBeTruthy();
  });
});
