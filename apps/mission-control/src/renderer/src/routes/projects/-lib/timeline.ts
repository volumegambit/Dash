import type { IssueComment, IssueEvent, TimelineItem } from '../../../../../shared/projects-ipc.js';

/** Merge issue events and comments into one chronological stream.
 *  Stable order at identical timestamps: events before comments. */
export function mergeTimeline(events: IssueEvent[], comments: IssueComment[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...events.map((event): TimelineItem => ({ kind: 'event', at: event.created_at, event })),
    ...comments.map(
      (comment): TimelineItem => ({ kind: 'comment', at: comment.created_at, comment }),
    ),
  ];
  return items.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    if (a.kind === b.kind) return 0;
    return a.kind === 'event' ? -1 : 1;
  });
}

/** True when an event is an agent-run row that the UI renders collapsible. */
export function isAgentRunEvent(event: IssueEvent): boolean {
  return event.type === 'agent_run_started' || event.type === 'agent_run_completed';
}
