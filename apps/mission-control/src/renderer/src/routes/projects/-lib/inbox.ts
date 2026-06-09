import type { InboxItem } from '../../../../../shared/projects-ipc.js';

export interface GroupedInbox {
  waitingOnYou: InboxItem[];
  newActivity: InboxItem[];
}

export function groupInbox(items: InboxItem[]): GroupedInbox {
  const waitingOnYou: InboxItem[] = [];
  const newActivity: InboxItem[] = [];
  for (const it of items) {
    // Data value is 'waiting_on_human'; the UI heading reads "Waiting on you".
    if (it.reason === 'waiting_on_human') waitingOnYou.push(it);
    else newActivity.push(it);
  }
  return { waitingOnYou, newActivity };
}
