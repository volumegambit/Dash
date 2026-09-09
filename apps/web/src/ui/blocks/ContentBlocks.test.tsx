import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConversationContent } from '@dash/mobile-contract';
import { fireEvent, render, screen } from '@testing-library/react';
import { ContentBlocks, getMessageCopyText } from './ContentBlocks.js';

type ChatOrderExpected = {
  kind: 'text' | 'thinking' | 'tool' | 'question';
  id?: string;
  label?: string;
  status?: 'running' | 'succeeded' | 'failed';
  text?: string;
};

type ChatOrderFixture = {
  version: number;
  cases: Array<{
    name: string;
    events: Extract<ConversationContent, { type: 'assistant' }>['events'];
    expected: ChatOrderExpected[];
  }>;
};

const chatOrderFixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../../../scripts/fixtures/chat-event-order.json'),
    'utf8',
  ),
) as ChatOrderFixture;

function orderedFixtureElements(expected: ChatOrderExpected[]): HTMLElement[] {
  const tools = screen.queryAllByTestId('tool-use-block');
  const thinking = screen.queryAllByTestId('thinking-block');
  let toolIndex = 0;
  let thinkingIndex = 0;
  return expected.map((entry) => {
    if (entry.kind === 'tool') {
      const element = tools[toolIndex++];
      expect(element).toBeTruthy();
      expect(element.textContent).toContain(entry.label);
      expect(element.getAttribute('data-status')).toBe(entry.status);
      return element;
    }
    if (entry.kind === 'thinking') {
      const element = thinking[thinkingIndex++];
      expect(element).toBeTruthy();
      return element;
    }
    return screen.getByText(entry.text ?? '');
  });
}

describe('ContentBlocks', () => {
  it.each(chatOrderFixture.cases)(
    'matches shared assistant event order: $name',
    ({ events, expected }) => {
      render(<ContentBlocks content={{ type: 'assistant', events }} />);
      const elements = orderedFixtureElements(expected);
      for (let index = 1; index < elements.length; index++) {
        expect(
          elements[index - 1].compareDocumentPosition(elements[index]) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    },
  );

  it('renders user content as text', () => {
    const content: ConversationContent = { type: 'user', text: 'Is the mobile connection ready?' };
    render(<ContentBlocks content={content} />);
    expect(screen.getByText('Is the mobile connection ready?')).toBeTruthy();
  });

  // Chat UX Phase 4 Task 5 (audit #14 remainder): a user message's attached
  // images render as thumbnails (MC parity, chat.tsx's `userImages`), sourced
  // straight from the contract's base64 `MobileImage`.
  it('renders user images as attached thumbnails', () => {
    const content: ConversationContent = {
      type: 'user',
      text: 'Look at these',
      images: [
        { mediaType: 'image/png', data: 'aGVsbG8=' },
        { mediaType: 'image/jpeg', data: 'd29ybGQ=' },
      ],
    };
    render(<ContentBlocks content={content} />);
    expect(screen.getByText('Look at these')).toBeTruthy();
    const images = screen.getAllByRole('img');
    expect(images.map((img) => img.getAttribute('src'))).toEqual([
      'data:image/png;base64,aGVsbG8=',
      'data:image/jpeg;base64,d29ybGQ=',
    ]);
    expect(images.map((img) => img.getAttribute('alt'))).toEqual(['Attachment 1', 'Attachment 2']);
  });

  it('renders assistant text_delta events as markdown', () => {
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

  it('splits assistant text on blank lines into separate markdown paragraphs', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [{ type: 'text_delta', text: 'First paragraph.\n\nSecond paragraph.' }],
    };
    const { container } = render(<ContentBlocks content={content} />);
    const paragraphs = container.querySelectorAll('.md-p');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].textContent).toBe('First paragraph.');
    expect(paragraphs[1].textContent).toBe('Second paragraph.');
  });

  it('renders a collapsed tool card with a status glyph, tool label, and summary, opening on click to reveal details and result', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        { type: 'tool_use_start', id: 'call-1', name: 'bash', input: { command: 'ls -la' } },
        { type: 'tool_use_delta', partial_json: '{}' },
        { type: 'tool_result', id: 'call-1', name: 'bash', content: 'file1\nfile2' },
      ],
    };
    render(<ContentBlocks content={content} />);

    const toolBlock = screen.getByTestId('tool-use-block');
    expect(toolBlock.tagName).toBe('DIV');
    expect(toolBlock.getAttribute('data-status')).toBe('succeeded');
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText('ls -la')).toBeTruthy();
    expect(screen.queryByTestId('tool-result')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Bash/ }));

    const result = screen.getByTestId('tool-result');
    expect(toolBlock.contains(result)).toBe(true);
    expect(result.textContent).toBe('file1\nfile2');
    expect(result.className).toContain('tool-result-short');
  });

  it('renders a TodoWrite call as a checklist, open without a click', () => {
    // Parity gap closed 2026-09-05: `parseTodos` had been ported to web and
    // unit-tested since the original port, and no view called it — a task
    // card showed "2/3 done" and, expanded, the literal string
    // "Todos: [3 items]". iOS and Mission Control both render the list.
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        {
          type: 'tool_use_start',
          id: 'call-1',
          name: 'todowrite',
          input: {
            todos: [
              { content: 'Draft the plan', status: 'completed' },
              { content: 'Check launch readiness', status: 'in_progress' },
              { content: 'Ship it', status: 'pending' },
            ],
          },
        },
      ],
    };
    render(<ContentBlocks content={content} />);

    // No click: the agent's plan is the one tool body worth showing by default.
    const list = screen.getByTestId('tool-todos');
    expect(list).toBeTruthy();
    expect(list.textContent).toContain('Draft the plan');
    expect(list.textContent).toContain('Check launch readiness');
    expect(list.textContent).toContain('Ship it');
    // Never the array-length placeholder the generic renderer produced.
    expect(screen.queryByText(/\[3 items\]/)).toBeNull();
  });

  it('marks todo status so completed and active items are distinguishable', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        {
          type: 'tool_use_start',
          id: 'call-1',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Done thing', status: 'completed' },
              { content: 'Doing thing', status: 'in_progress' },
            ],
          },
        },
      ],
    };
    render(<ContentBlocks content={content} />);

    const items = screen.getAllByTestId('tool-todo-item');
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute('data-status')).toBe('completed');
    expect(items[1].getAttribute('data-status')).toBe('in_progress');
  });

  it('leaves non-todo tool cards collapsed by default', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [{ type: 'tool_use_start', id: 'call-1', name: 'bash', input: { command: 'ls' } }],
    };
    render(<ContentBlocks content={content} />);
    expect(screen.queryByTestId('tool-todos')).toBeNull();
  });

  it('renders an in-progress (running) tool card when no tool-result has arrived yet', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [{ type: 'tool_use_start', id: 'call-1', name: 'bash', input: { command: 'ls' } }],
    };
    render(<ContentBlocks content={content} />);
    const toolBlock = screen.getByTestId('tool-use-block');
    expect(toolBlock.getAttribute('data-status')).toBe('running');
    expect(toolBlock.textContent).toContain('Bash');
    expect(screen.queryByTestId('tool-result')).toBeNull();
  });

  it('tints a failed tool card red and renders the error result without a click', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        { type: 'tool_use_start', id: 'call-1', name: 'bash', input: { command: 'false' } },
        {
          type: 'tool_result',
          id: 'call-1',
          name: 'bash',
          content: 'command not found',
          isError: true,
        },
      ],
    };
    render(<ContentBlocks content={content} />);
    const toolBlock = screen.getByTestId('tool-use-block');
    expect(toolBlock.getAttribute('data-status')).toBe('failed');
    expect(toolBlock.className).toContain('tool-card-error');

    // No click: a failed call opens by default (tool-use UX 2026-09-05). The
    // one case whose body you always want was behind the same tap as a
    // successful read.
    const result = screen.getByTestId('tool-result');
    expect(result.className).toContain('tool-result-error');
    expect(result.textContent).toBe('command not found');
  });

  it('renders "No output" (muted italic) for an empty successful result', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        { type: 'tool_use_start', id: 'call-1', name: 'bash', input: { command: 'true' } },
        { type: 'tool_result', id: 'call-1', name: 'bash', content: '   ' },
      ],
    };
    render(<ContentBlocks content={content} />);
    fireEvent.click(screen.getByRole('button', { name: /Bash/ }));
    const result = screen.getByTestId('tool-result');
    expect(result.className).toContain('tool-result-empty');
    expect(result.textContent).toBe('No output');
  });

  it('caps a longer (>3 line) result to a scrollable 256px block', () => {
    const longContent = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        { type: 'tool_use_start', id: 'call-1', name: 'read', input: { path: 'src/index.ts' } },
        { type: 'tool_result', id: 'call-1', name: 'read', content: longContent },
      ],
    };
    render(<ContentBlocks content={content} />);
    fireEvent.click(screen.getByRole('button', { name: /Read/ }));
    const result = screen.getByTestId('tool-result');
    expect(result.tagName).toBe('PRE');
    expect(result.className).toContain('tool-result-long');
    expect(result.textContent).toBe(longContent);
  });

  it("skips the read tool's path/offset/limit in the expanded details list (already shown in the summary)", () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        {
          type: 'tool_use_start',
          id: 'call-1',
          name: 'read',
          input: { path: 'src/index.ts', offset: 0, limit: 100 },
        },
        { type: 'tool_result', id: 'call-1', name: 'read', content: 'ok' },
      ],
    };
    render(<ContentBlocks content={content} />);
    fireEvent.click(screen.getByRole('button', { name: /Read/ }));
    expect(screen.queryByText(/Offset:/)).toBeNull();
    expect(screen.queryByText(/Limit:/)).toBeNull();
    expect(screen.queryByText(/Path:/)).toBeNull();
  });

  it('renders a thinking block, collapsed by default with "Show thinking" copy, toggling to "Hide thinking" on click', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [{ type: 'thinking_delta', text: 'Considering the options...' }],
    };
    render(<ContentBlocks content={content} />);
    const thinkingBlock = screen.getByTestId('thinking-block');
    expect(thinkingBlock.tagName).toBe('DETAILS');
    expect(thinkingBlock.hasAttribute('open')).toBe(false);
    expect(screen.getByText('Show thinking')).toBeTruthy();
    expect(thinkingBlock.textContent).toContain('Considering the options...');

    fireEvent.click(screen.getByText('Show thinking'));
    expect(screen.getByText('Hide thinking')).toBeTruthy();
    expect(thinkingBlock.hasAttribute('open')).toBe(true);
  });

  it('renders a realistic turn (text_delta, text_delta, response) with no unknown-block, since response is a silent end-of-turn metadata event', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        { type: 'text_delta', text: 'All set. ' },
        { type: 'text_delta', text: 'Mobile access is ready.' },
        {
          type: 'response',
          content: 'All set. Mobile access is ready.',
          usage: { inputTokens: 12, outputTokens: 6 },
        },
      ],
    };
    render(<ContentBlocks content={content} />);
    expect(screen.getByText('All set. Mobile access is ready.')).toBeTruthy();
    expect(screen.queryByTestId('unknown-block')).toBeNull();
  });

  it("renders a question event's prompt text as a plain paragraph, with no unknown-block", () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        { type: 'text_delta', text: 'One more thing — ' },
        {
          type: 'question',
          id: 'question-01',
          question: 'Confirm mobile access?',
          options: ['Yes', 'No'],
        },
      ],
    };
    render(<ContentBlocks content={content} />);
    expect(screen.getByText('One more thing —')).toBeTruthy();
    expect(screen.getByText('Confirm mobile access?')).toBeTruthy();
    expect(screen.queryByTestId('unknown-block')).toBeNull();
  });

  it('renders memory events as a chip instead of unknown content', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        { type: 'text_delta', text: 'Noted. ' },
        {
          type: 'memory_saved',
          name: 'user-timezone',
          description: 'Gerry is in Singapore',
          memoryType: 'user',
          action: 'created',
        },
        {
          type: 'memory_saved',
          name: 'user-timezone',
          description: 'Gerry is in Singapore (UTC+8)',
          memoryType: 'user',
          action: 'updated',
        },
        { type: 'memory_forgotten', name: 'old-fact' },
      ],
    };
    render(<ContentBlocks content={content} />);
    expect(screen.getByText('Noted.')).toBeTruthy();
    expect(screen.getByText('Remembered: Gerry is in Singapore')).toBeTruthy();
    expect(screen.getByText('Updated memory: Gerry is in Singapore (UTC+8)')).toBeTruthy();
    expect(screen.getByText('Forgot: old-fact')).toBeTruthy();
    expect(screen.queryByTestId('unknown-block')).toBeNull();
  });

  it('renders a fallback unknown-block for a malformed memory event', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [{ type: 'memory_saved', name: 'user-timezone', action: 'created' }],
    };
    expect(() => render(<ContentBlocks content={content} />)).not.toThrow();
    expect(screen.getByTestId('unknown-block')).toBeTruthy();
  });

  it('renders a fallback unknown-block for an unrecognized event type, without throwing', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [{ type: 'telemetry_ping', channel: 'metrics' }],
    };
    expect(() => render(<ContentBlocks content={content} />)).not.toThrow();
    expect(screen.getByTestId('unknown-block')).toBeTruthy();
  });

  // Task D2: `agent_spawned` is the coordinator's name-only announcement,
  // pushed between a child's `worker_spawned` and its `subagent_started`
  // (`packages/swarm/src/coordinator.ts`). The sub-agent row next to it is
  // what renders the spawn — the announcement itself must not badge every
  // spawn with an "Unsupported content" marker.
  it('treats agent_spawned as chrome rather than unsupported content', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [{ type: 'agent_spawned', name: 'worker-1' }],
    };
    render(<ContentBlocks content={content} />);
    expect(screen.queryByTestId('unknown-block')).toBeNull();
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

  // The card is created while the call is still running, so its useState
  // initial value is computed with status 'running'. A failure that arrives
  // afterwards must still open it, or "failures open by default" only holds
  // for a reloaded transcript and silently fails live — the case that matters.
  it('opens a call that fails after it was already rendered as running', () => {
    const running: ConversationContent = {
      type: 'assistant',
      events: [{ type: 'tool_use_start', id: 'call-1', name: 'bash', input: { command: 'nope' } }],
    };
    const { rerender } = render(<ContentBlocks content={running} />);
    expect(screen.queryByTestId('tool-result')).toBeNull();

    const failed: ConversationContent = {
      type: 'assistant',
      events: [
        { type: 'tool_use_start', id: 'call-1', name: 'bash', input: { command: 'nope' } },
        {
          type: 'tool_result',
          id: 'call-1',
          name: 'bash',
          content: 'command not found',
          isError: true,
        },
      ],
    };
    rerender(<ContentBlocks content={failed} />);
    expect(screen.getByTestId('tool-result').textContent).toBe('command not found');
  });
  it('shows what a tool call returned in the collapsed header', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        { type: 'tool_use_start', id: 'call-1', name: 'grep', input: { pattern: 'foo' } },
        { type: 'tool_result', id: 'call-1', name: 'grep', content: 'a.ts:1: foo\nb.ts:2: foo' },
      ],
    };
    render(<ContentBlocks content={content} />);
    expect(screen.getByTestId('tool-card-outcome').textContent).toBe('2 matches');
  });

  it('says nothing in the header while a tool is still running', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        { type: 'tool_use_start', id: 'call-1', name: 'bash', input: { command: 'sleep 5' } },
      ],
    };
    render(<ContentBlocks content={content} />);
    expect(screen.queryByTestId('tool-card-outcome')).toBeNull();
  });

  it('opens a failed tool call without a click, showing the error once', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        { type: 'tool_use_start', id: 'call-1', name: 'bash', input: { command: 'nope' } },
        {
          type: 'tool_result',
          id: 'call-1',
          name: 'bash',
          content: 'command not found',
          isError: true,
        },
      ],
    };
    render(<ContentBlocks content={content} />);
    expect(screen.getByTestId('tool-result').textContent).toBe('command not found');
    // ONCE: the header outcome is hidden while expanded, matching iOS. It used
    // to print the same error text right-aligned in the header as well.
    expect(screen.queryByTestId('tool-card-outcome')).toBeNull();
  });

  it('keeps a successful tool call collapsed', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        { type: 'tool_use_start', id: 'call-1', name: 'bash', input: { command: 'ls' } },
        { type: 'tool_result', id: 'call-1', name: 'bash', content: 'a\nb' },
      ],
    };
    render(<ContentBlocks content={content} />);
    expect(screen.queryByTestId('tool-result')).toBeNull();
  });

  it('reports an edit as a diff stat, from the result details', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        { type: 'tool_use_start', id: 'call-1', name: 'edit', input: { path: 'x.ts' } },
        {
          type: 'tool_result',
          id: 'call-1',
          name: 'edit',
          content: 'ok',
          details: { diff: '--- a/x.ts\n+++ b/x.ts\n-old\n+new' },
        },
      ],
    };
    render(<ContentBlocks content={content} />);
    expect(screen.getByTestId('tool-card-outcome').textContent).toBe('+1 -1');
  });

  it('does not print TodoWrite\'s own "ok" result under the checklist', () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        {
          type: 'tool_use_start',
          id: 'call-1',
          name: 'TodoWrite',
          input: { todos: [{ content: 'Ship it', status: 'pending' }] },
        },
        { type: 'tool_result', id: 'call-1', name: 'TodoWrite', content: 'ok' },
      ],
    };
    render(<ContentBlocks content={content} />);
    expect(screen.getByTestId('tool-todos')).toBeTruthy();
    expect(screen.queryByTestId('tool-result')).toBeNull();
  });
});

describe('paragraph keys', () => {
  it('renders every paragraph when a block repeats identical text', () => {
    // Regression check: an earlier custom paragraph-splitter derived React
    // keys from paragraph content, so identical paragraphs collided and
    // only the first rendered. Markdown (react-markdown) does its own
    // virtual-dom diffing and has no such issue.
    const content: ConversationContent = {
      type: 'assistant',
      events: [{ type: 'text_delta', text: 'same\n\nsame\n\nsame' }],
    };
    const { container } = render(<ContentBlocks content={content} />);
    expect(container.querySelectorAll('.md-p')).toHaveLength(3);
  });
});

describe('getMessageCopyText', () => {
  it("returns a user message's plain text", () => {
    expect(getMessageCopyText({ type: 'user', text: 'hello there' })).toBe('hello there');
  });

  it("concatenates an assistant message's text_delta text only, excluding tool/thinking content", () => {
    const content: ConversationContent = {
      type: 'assistant',
      events: [
        { type: 'thinking_delta', text: 'hmm...' },
        { type: 'text_delta', text: 'Here is ' },
        { type: 'tool_use_start', id: 'call-1', name: 'bash', input: { command: 'ls' } },
        { type: 'tool_result', id: 'call-1', name: 'bash', content: 'file1' },
        { type: 'text_delta', text: 'the answer.' },
      ],
    };
    expect(getMessageCopyText(content)).toBe('Here is the answer.');
  });

  it('returns an empty string for malformed content', () => {
    expect(getMessageCopyText({ type: 'bogus' } as unknown as ConversationContent)).toBe('');
  });

  // Tool-use UX 2026-09-05: the collapsed row answers what the agent did, to
  // what, and what came back. The third was missing entirely.
});

describe('notice content', () => {
  it('renders a learned-skill notice as a chip', () => {
    const { container } = render(
      <ContentBlocks
        content={{ type: 'notice', kind: 'skill_learned', text: 'Learned: write-files' } as never}
      />,
    );
    const chip = container.querySelector('[data-testid="notice-chip"]');
    expect(chip?.textContent).toBe('Learned: write-files');
    expect(chip?.getAttribute('data-notice-kind')).toBe('skill_learned');
  });

  it('renders a swept-memory notice as a chip', () => {
    const { container } = render(
      <ContentBlocks
        content={
          { type: 'notice', kind: 'memory_saved', text: 'Remembered: prefers printf' } as never
        }
      />,
    );
    expect(container.querySelector('[data-notice-kind="memory_saved"]')).not.toBeNull();
  });

  it('does not fall through to the unknown-content block', () => {
    // Before the notice branch existed this degraded to UnknownBlock, which is
    // what a client too old to know about notices still does.
    const { container } = render(
      <ContentBlocks content={{ type: 'notice', kind: 'skill_learned', text: 'x' } as never} />,
    );
    expect(container.querySelector('[data-testid="notice-chip"]')).not.toBeNull();
  });
});
