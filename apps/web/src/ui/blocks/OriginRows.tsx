import type { ConversationMessage } from '@dash/mobile-contract';
import type { ReactNode } from 'react';
import { notificationRowLabel } from '../notification-row.js';

/**
 * The two `role: 'user'` rows the USER did not write (sub-agents design §8.5).
 * Both render as compact muted system lines — never a user bubble, never
 * editable, never resendable — and both are reachable from two places now that
 * task D2 made child transcripts navigable: `ChatView`'s `MessageRow` (the
 * orchestrator's own transcript) and `SubagentBlock`'s nested transcript (a
 * child's). They live here, beside `ContentBlocks`, so both callers share one
 * implementation rather than drifting.
 */

/**
 * `origin: 'notification'`: the gateway started this turn to wake the
 * orchestrator with a background sub-agent's result, and the row's text is the
 * `[SYSTEM NOTIFICATION - NOT USER INPUT]` block it was fed — summarized by
 * `notificationRowLabel` rather than shown raw.
 */
export function isNotificationRow(message: ConversationMessage): boolean {
  return message.role === 'user' && message.origin === 'notification';
}

/**
 * `origin: 'parent'`: an orchestrator message inside a CHILD's transcript —
 * the brief that kicked the child off, or a follow-up typed into it. Task C7
 * left `isNotificationRow` true for this, which would collapse it to the
 * generic bell label and throw its text away; §8.5 gives it a row of its own
 * that keeps the text, because that text is the actual instruction the child
 * is working from.
 */
export function isOrchestratorRow(message: ConversationMessage): boolean {
  return message.role === 'user' && message.origin === 'parent';
}

function messageText(message: ConversationMessage): string {
  return message.content.type === 'user' ? message.content.text : '';
}

function BellIcon(): ReactNode {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M10 18.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** Downward arrow into a box — "handed down from the orchestrator". Drawn
 * inline for the same reason every other glyph in this app is: apps/web has no
 * icon-library dependency. */
function HandDownIcon(): ReactNode {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 4v10m0 0-4-4m4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M5 19h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function NotificationRow({ message }: { message: ConversationMessage }): ReactNode {
  return (
    <div className="chat-notification-row" data-testid="notification-row" data-role="notification">
      <BellIcon />
      <span>{notificationRowLabel(messageText(message))}</span>
    </div>
  );
}

/** Exact muted attribution shown before an orchestrator message's own text. */
export const ORCHESTRATOR_ROW_LABEL = 'from orchestrator';

export function OrchestratorRow({ message }: { message: ConversationMessage }): ReactNode {
  return (
    <div className="chat-orchestrator-row" data-testid="orchestrator-row" data-role="parent">
      <HandDownIcon />
      <span className="chat-orchestrator-label">{ORCHESTRATOR_ROW_LABEL}</span>
      <span className="chat-orchestrator-text">{messageText(message)}</span>
    </div>
  );
}
