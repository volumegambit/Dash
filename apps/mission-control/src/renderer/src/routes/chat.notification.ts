/**
 * Mission Control's port of `apps/web/src/ui/notification-row.ts`, kept
 * byte-identical below the header for the same reason `chat.swarm.ts` mirrors
 * `blocks/subagents.ts`: the two apps share no renderer package, and a second
 * hand-written summarizer is how the two surfaces drift.
 *
 * Rendering helpers for a `origin: 'notification'` message (sub-agents design
 * 8.5): the user-side row of a turn the GATEWAY started to wake the
 * orchestrator with a background child's result. Its text is the notification
 * block `packages/swarm/src/notifications.ts` composes — a
 * `[SYSTEM NOTIFICATION - NOT USER INPUT]` preamble plus one
 * `<task-notification>`/`<subagent-message>` block per queued notification —
 * so the row shows the block's own `<summary>` rather than the raw prompt the
 * model was fed.
 */

/**
 * Shown when there is no text to summarize. That is the LIVE path: an
 * `accepted` frame carries `origin` but not the message text, so the row
 * exists before its content does (the text arrives with the next REST replay).
 */
export const NOTIFICATION_ROW_FALLBACK = 'Background task update';

function unescapeAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/** Every `<tag>…</tag>` body in `text`, in document order. */
function taggedValues(text: string, open: string, close: string): string[] {
  const values: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(open, cursor);
    if (start === -1) break;
    const from = start + open.length;
    const end = text.indexOf(close, from);
    if (end === -1) break;
    const value = text.slice(from, end).trim();
    if (value) values.push(value);
    cursor = end + close.length;
  }
  return values;
}

/**
 * One muted line for a notification row. Every notification queued for a
 * conversation rides ONE turn in creation order (design 7.3, "coalescing"), so
 * a turn carrying several is summarized as several summaries.
 */
export function notificationRowLabel(text: string): string {
  const summaries = taggedValues(text, '<summary>', '</summary>');
  if (summaries.length > 0) return summaries.join(' · ');

  const senders = taggedValues(text, '<subagent-message from="', '">').map(unescapeAttribute);
  if (senders.length > 0) return `Message from ${senders.join(', ')}`;

  return NOTIFICATION_ROW_FALLBACK;
}
