import '@testing-library/jest-dom/vitest';
import type { McMessage } from '@dash/mc';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { McAgentEvent } from '../../../shared/ipc.js';
import {
  CompactionDivider,
  CompactionToast,
  ContextChip,
  DEFAULT_RESERVE_TOKENS,
  ModelChangeToast,
  computeContextStatus,
  inferContextWindow,
  latestUsageFromConversation,
  messageEvents,
  totalContextTokens,
} from './chat.context.js';

const ts = '2026-04-13T00:00:00.000Z';

function asstMessage(events: McAgentEvent[]): McMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: { type: 'assistant', events },
    timestamp: ts,
  };
}

function userMessage(text: string): McMessage {
  return {
    id: 'u1',
    role: 'user',
    content: { type: 'user', text },
    timestamp: ts,
  };
}

// ---------- Pure helpers ----------

describe('totalContextTokens', () => {
  it('sums camelCase keys (agent backend shape)', () => {
    expect(
      totalContextTokens({
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
      }),
    ).toBe(180);
  });

  it('sums snake_case keys (provider passthrough shape)', () => {
    expect(
      totalContextTokens({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 20,
        cache_write_tokens: 10,
      }),
    ).toBe(180);
  });

  it('treats missing fields as zero', () => {
    expect(totalContextTokens({ inputTokens: 100 })).toBe(100);
    expect(totalContextTokens({})).toBe(0);
  });

  it('prefers camelCase when both shapes are present', () => {
    expect(totalContextTokens({ inputTokens: 100, input_tokens: 999 })).toBe(100);
  });
});

describe('inferContextWindow', () => {
  it('claude → 200k', () => {
    expect(inferContextWindow('claude-sonnet-4-6')).toBe(200_000);
    expect(inferContextWindow('claude-opus-4-6')).toBe(200_000);
  });

  it('claude with [1m] suffix → 1M', () => {
    expect(inferContextWindow('claude-opus-4-6[1m]')).toBe(1_000_000);
  });

  it('gemini → 1M', () => {
    expect(inferContextWindow('gemini-2.5-pro')).toBe(1_000_000);
  });

  it('gpt-4o / o1 / gpt-4-turbo → 128k', () => {
    expect(inferContextWindow('gpt-4o')).toBe(128_000);
    expect(inferContextWindow('o1-preview')).toBe(128_000);
    expect(inferContextWindow('gpt-4-turbo')).toBe(128_000);
  });

  it('legacy gpt-4 → 8k', () => {
    expect(inferContextWindow('gpt-4')).toBe(8_192);
  });

  it('unknown / undefined → 128k default', () => {
    expect(inferContextWindow(undefined)).toBe(128_000);
    expect(inferContextWindow('mystery-model-9000')).toBe(128_000);
  });

  it('case-insensitive', () => {
    expect(inferContextWindow('CLAUDE-OPUS-4-6')).toBe(200_000);
  });
});

describe('messageEvents', () => {
  it('returns events from assistant messages', () => {
    const ev: McAgentEvent = { type: 'text_delta', text: 'hi' };
    expect(messageEvents(asstMessage([ev]))).toEqual([ev]);
  });

  it('returns empty array for user messages', () => {
    expect(messageEvents(userMessage('hello'))).toEqual([]);
  });
});

describe('latestUsageFromConversation', () => {
  it('returns null when there are no response events', () => {
    expect(latestUsageFromConversation([], [])).toBeNull();
  });

  it('prefers live stream over history when both have responses', () => {
    const history = [
      asstMessage([
        { type: 'response', content: 'old', usage: { inputTokens: 1, outputTokens: 1 } },
      ]),
    ];
    const live: McAgentEvent[] = [
      { type: 'response', content: 'new', usage: { inputTokens: 99, outputTokens: 99 } },
    ];
    expect(latestUsageFromConversation(history, live)).toEqual({
      inputTokens: 99,
      outputTokens: 99,
    });
  });

  it('falls back to history when live has no response', () => {
    const history = [
      asstMessage([
        { type: 'response', content: 'h1', usage: { inputTokens: 10, outputTokens: 5 } },
      ]),
    ];
    expect(latestUsageFromConversation(history, [])).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it('walks history newest-first and returns the latest response', () => {
    const history = [
      asstMessage([
        { type: 'response', content: 'first', usage: { inputTokens: 1, outputTokens: 1 } },
      ]),
      asstMessage([
        { type: 'response', content: 'second', usage: { inputTokens: 2, outputTokens: 2 } },
      ]),
      asstMessage([
        { type: 'response', content: 'third', usage: { inputTokens: 3, outputTokens: 3 } },
      ]),
    ];
    expect(latestUsageFromConversation(history, [])).toEqual({
      inputTokens: 3,
      outputTokens: 3,
    });
  });

  it('skips user messages and finds the last assistant response', () => {
    const history = [
      asstMessage([
        { type: 'response', content: 'old', usage: { inputTokens: 5, outputTokens: 5 } },
      ]),
      userMessage('a question'),
    ];
    expect(latestUsageFromConversation(history, [])).toEqual({
      inputTokens: 5,
      outputTokens: 5,
    });
  });

  it('walks live stream backwards to find most recent response', () => {
    const live: McAgentEvent[] = [
      { type: 'response', content: 'a', usage: { inputTokens: 10, outputTokens: 10 } },
      { type: 'text_delta', text: 'more' },
      { type: 'response', content: 'b', usage: { inputTokens: 20, outputTokens: 20 } },
    ];
    expect(latestUsageFromConversation([], live)).toEqual({
      inputTokens: 20,
      outputTokens: 20,
    });
  });
});

describe('computeContextStatus', () => {
  it('returns zeros when usage is null', () => {
    const s = computeContextStatus(null, 'claude-sonnet-4-6');
    expect(s.tokensUsed).toBe(0);
    expect(s.pct).toBe(0);
    expect(s.threshold).toBe(200_000 - DEFAULT_RESERVE_TOKENS);
  });

  it('computes percentage against (window - reserve)', () => {
    // sonnet → 200k, threshold = 183_616, half of that ≈ 91_808
    const s = computeContextStatus({ inputTokens: 91_808, outputTokens: 0 }, 'claude-sonnet-4-6');
    expect(s.tokensUsed).toBe(91_808);
    expect(s.threshold).toBe(183_616);
    expect(s.pct).toBe(50);
  });

  it('clamps percentage at 100 for absurdly large inputs', () => {
    const s = computeContextStatus({ inputTokens: 999_999_999 }, 'claude-sonnet-4-6');
    expect(s.pct).toBe(100);
  });

  it('returns 0 when usage object is empty', () => {
    const s = computeContextStatus({}, 'claude-sonnet-4-6');
    expect(s.pct).toBe(0);
  });

  it('respects custom reserveTokens override', () => {
    // Window 200k, reserve 100k → threshold 100k. 50k tokens = 50%.
    const s = computeContextStatus({ inputTokens: 50_000 }, 'claude-sonnet-4-6', 100_000);
    expect(s.threshold).toBe(100_000);
    expect(s.pct).toBe(50);
  });

  it('uses 128k default for unknown model', () => {
    const s = computeContextStatus({ inputTokens: 0 }, undefined);
    expect(s.threshold).toBe(128_000 - DEFAULT_RESERVE_TOKENS);
  });

  it('compaction events do not contaminate usage math', () => {
    // compaction events carry no usage, so they cannot mislead the chip
    const live: McAgentEvent[] = [
      { type: 'response', content: '', usage: { inputTokens: 100 } },
      { type: 'context_compacted', overflow: false },
    ];
    const usage = latestUsageFromConversation([], live);
    const s = computeContextStatus(usage, 'claude-sonnet-4-6');
    expect(s.tokensUsed).toBe(100);
  });
});

// ---------- Presentational components ----------

describe('ContextChip', () => {
  it('renders ctx label + percentage', () => {
    render(<ContextChip tokensUsed={50_000} threshold={184_000} pct={27} />);
    const chip = screen.getByTestId('context-chip');
    expect(chip.textContent).toContain('ctx');
    expect(chip.textContent).toContain('50.0k');
    expect(chip.textContent).toContain('184.0k');
    expect(chip.textContent).toContain('(27%)');
  });

  it('uses muted tone below 60%', () => {
    render(<ContextChip tokensUsed={1000} threshold={10_000} pct={10} />);
    expect(screen.getByTestId('context-chip')).toHaveAttribute('data-tone', 'text-muted');
  });

  it('uses accent tone in 60-79% range', () => {
    render(<ContextChip tokensUsed={7000} threshold={10_000} pct={70} />);
    expect(screen.getByTestId('context-chip')).toHaveAttribute('data-tone', 'text-accent');
  });

  it('uses yellow tone in 80-94% range', () => {
    render(<ContextChip tokensUsed={8500} threshold={10_000} pct={85} />);
    expect(screen.getByTestId('context-chip')).toHaveAttribute('data-tone', 'text-yellow');
  });

  it('uses red tone at 95% and above', () => {
    render(<ContextChip tokensUsed={9700} threshold={10_000} pct={97} />);
    expect(screen.getByTestId('context-chip')).toHaveAttribute('data-tone', 'text-red');
  });

  it('exposes raw token counts in the tooltip title', () => {
    render(<ContextChip tokensUsed={50_000} threshold={184_000} pct={27} />);
    expect(screen.getByTestId('context-chip')).toHaveAttribute(
      'title',
      'Context: 50,000 / 184,000 tokens before compaction',
    );
  });
});

describe('CompactionDivider', () => {
  it('renders default label when overflow=false', () => {
    render(<CompactionDivider overflow={false} />);
    const divider = screen.getByTestId('compaction-divider');
    expect(divider).toHaveAttribute('data-overflow', 'false');
    expect(divider.textContent).toContain('context compacted');
    expect(divider.textContent).not.toContain('overflow');
  });

  it('renders overflow label when overflow=true', () => {
    render(<CompactionDivider overflow={true} />);
    const divider = screen.getByTestId('compaction-divider');
    expect(divider).toHaveAttribute('data-overflow', 'true');
    expect(divider.textContent).toContain('overflow');
  });

  it('applies red border styling for overflow', () => {
    render(<CompactionDivider overflow={true} />);
    const divider = screen.getByTestId('compaction-divider');
    expect(divider.className).toContain('text-red');
  });
});

describe('CompactionToast', () => {
  it('renders compacted message with status role', () => {
    render(<CompactionToast overflow={false} />);
    const toast = screen.getByRole('status');
    expect(toast).toHaveAttribute('data-overflow', 'false');
    expect(toast.textContent).toContain('Context compacted');
  });

  it('renders overflow message when overflow=true', () => {
    render(<CompactionToast overflow={true} />);
    const toast = screen.getByRole('status');
    expect(toast).toHaveAttribute('data-overflow', 'true');
    expect(toast.textContent).toContain('Context overflow');
  });

  it('uses red tone for overflow', () => {
    render(<CompactionToast overflow={true} />);
    expect(screen.getByRole('status').className).toContain('text-red');
  });

  it('uses accent tone for normal compaction', () => {
    render(<CompactionToast overflow={false} />);
    expect(screen.getByRole('status').className).toContain('text-accent');
  });
});

describe('ModelChangeToast', () => {
  it('renders model change message with status role', () => {
    render(<ModelChangeToast modelName="Claude 3.5 Sonnet" />);
    const toast = screen.getByRole('status');
    expect(toast).toHaveAttribute('data-testid', 'model-change-toast');
    expect(toast.textContent).toContain('Model changed to Claude 3.5 Sonnet');
  });

  it('uses accent tone styling', () => {
    render(<ModelChangeToast modelName="GPT-4" />);
    const toast = screen.getByRole('status');
    expect(toast.className).toContain('text-accent');
    expect(toast.className).toContain('border-accent');
    expect(toast.className).toContain('bg-accent/15');
  });

  it('displays the provided model name', () => {
    render(<ModelChangeToast modelName="Custom Model Name" />);
    const toast = screen.getByRole('status');
    expect(toast.textContent).toBe('Model changed to Custom Model Name');
  });
});
