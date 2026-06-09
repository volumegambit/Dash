import { describe, expect, it } from 'vitest';
import type { IssueComment, IssueEvent } from '../../../../../shared/projects-ipc.js';
import { mergeTimeline } from './timeline.js';

function evt(id: string, at: string, type: IssueEvent['type'] = 'status_change'): IssueEvent {
  return {
    id,
    issue_id: 'i1',
    type,
    actor_type: 'human',
    actor_id: 'u1',
    data: '{}',
    created_at: at,
  };
}
function cmt(id: string, at: string, deleted = false): IssueComment {
  return {
    id,
    issue_id: 'i1',
    author_type: 'human',
    author_id: 'u1',
    body: 'hi',
    created_at: at,
    updated_at: at,
    deleted_at: deleted ? at : null,
  };
}

describe('mergeTimeline', () => {
  it('interleaves events and comments in chronological order', () => {
    const out = mergeTimeline(
      [evt('e1', '2026-06-01T00:00:00Z'), evt('e2', '2026-06-03T00:00:00Z')],
      [cmt('c1', '2026-06-02T00:00:00Z')],
    );
    expect(out.map((i) => (i.kind === 'event' ? i.event.id : i.comment.id))).toEqual([
      'e1',
      'c1',
      'e2',
    ]);
  });

  it('keeps deleted comments in the stream (UI renders a placeholder)', () => {
    const out = mergeTimeline([], [cmt('c1', '2026-06-02T00:00:00Z', true)]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('comment');
  });

  it('breaks ties by putting events before comments at the same timestamp', () => {
    const out = mergeTimeline(
      [evt('e1', '2026-06-01T00:00:00Z')],
      [cmt('c1', '2026-06-01T00:00:00Z')],
    );
    expect(out[0].kind).toBe('event');
  });
});
