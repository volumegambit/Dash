import { useEffect } from 'react';
import { useAgentsStore } from '../stores/agents.js';
import { useChatStore } from '../stores/chat.js';
import { useUIStore } from '../stores/ui.js';
import { selectCompanionSessions } from './selectCompanionSessions.js';
import { buildSnapshot } from './snapshot.js';

/**
 * Headless publisher: the companion tree now lives in its own always-on-top
 * window (see main/companion-window.ts). This component keeps computing the
 * session statuses from the renderer stores and streams them over IPC; it
 * renders nothing. CompanionStack remains in-tree (unmounted) as the basis
 * for future widget tooltips.
 */
export function Companion(): null {
  const chat = useChatStore();
  const agents = useAgentsStore();
  const companionVisible = useUIStore((s) => s.companionVisible);

  const statuses = selectCompanionSessions(buildSnapshot(chat, agents)).map((s) => s.status);
  const key = statuses.join(',');

  // Keep the widget window's existence in sync with the persisted preference.
  useEffect(() => {
    void window.api.companionSetVisible(companionVisible);
  }, [companionVisible]);

  // Publish on change + on replay requests (widget just opened).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the content-hash trigger for `statuses`; `statuses` itself is a fresh array each render
  useEffect(() => {
    if (!companionVisible) return undefined;
    window.api.companionPublishStatuses(statuses);
    return window.api.onCompanionReplayRequest(() => window.api.companionPublishStatuses(statuses));
  }, [key, companionVisible]);

  return null;
}
