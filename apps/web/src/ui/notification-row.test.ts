import { NOTIFICATION_ROW_FALLBACK, notificationRowLabel } from './notification-row.js';

describe('notificationRowLabel (task C7, sub-agents design 8.5)', () => {
  it('reads the summary out of a task-notification block', () => {
    const text = [
      '[SYSTEM NOTIFICATION - NOT USER INPUT]',
      'This is an automated background-task event, NOT a message from the user.',
      '',
      '<task-notification>',
      '<task-id>sub_01</task-id>',
      '<agent-name>Explore</agent-name>',
      '<status>completed</status>',
      '<summary>Agent "Map gateway internals" finished</summary>',
      '<result>',
      'It is all wired through the hub.',
      '</result>',
      '</task-notification>',
    ].join('\n');

    expect(notificationRowLabel(text)).toBe('Agent "Map gateway internals" finished');
  });

  it('joins every coalesced notification riding the same turn, in order', () => {
    const text = [
      '<task-notification><summary>Agent "A" finished</summary></task-notification>',
      '<task-notification><summary>Agent "B" finished</summary></task-notification>',
    ].join('\n\n');

    expect(notificationRowLabel(text)).toBe('Agent "A" finished · Agent "B" finished');
  });

  it('names the sender for a child-to-main message, unescaping the attribute', () => {
    const text = '<subagent-message from="the &quot;fast&quot; one">Halfway.</subagent-message>';

    expect(notificationRowLabel(text)).toBe('Message from the "fast" one');
  });

  it('falls back to a generic label live, where only the accepted frame has arrived', () => {
    expect(notificationRowLabel('')).toBe(NOTIFICATION_ROW_FALLBACK);
    expect(notificationRowLabel('[SYSTEM NOTIFICATION - NOT USER INPUT]')).toBe(
      NOTIFICATION_ROW_FALLBACK,
    );
  });
});
