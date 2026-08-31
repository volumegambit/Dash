import { useEffect } from 'react';
import type { CompanionAgentStatus } from '../../../shared/ipc.js';
import { useAgentsStore } from '../stores/agents.js';
import { useChatStore } from '../stores/chat.js';
import { useUIStore } from '../stores/ui.js';
import { selectCompanionSessions } from './selectCompanionSessions.js';
import { buildSnapshot } from './snapshot.js';

/**
 * Headless publisher: the companion now lives in its own always-on-top
 * window (see main/companion-window.ts), which renders the user's selected
 * pet. This component keeps computing the session statuses from the renderer
 * stores and streams them — along with the selected pet — over IPC; it
 * renders nothing.
 */
export function Companion(): null {
  const chat = useChatStore();
  const agents = useAgentsStore();
  const companionVisible = useUIStore((s) => s.companionVisible);
  const companionSelection = useUIStore((s) => s.companionSelection);

  const sessions = selectCompanionSessions(buildSnapshot(chat, agents));
  const statuses: CompanionAgentStatus[] = sessions.map((s) => ({
    agentId: s.agentId,
    agentName: s.agentName,
    status: s.status,
    preview: s.preview,
  }));
  // Content hash: any change to an entry's identity, status, or preview must
  // re-publish, so the widget reflects live tool activity in its bubbles.
  const key = sessions
    .map((session) =>
      [session.conversationKey, session.agentId, session.status, session.preview].join(':'),
    )
    .join('|');

  // Keep the widget window's existence in sync with the persisted preference.
  useEffect(() => {
    void window.api.companionSetVisible(companionVisible);
  }, [companionVisible]);

  // Publish on change + on replay requests (widget just opened).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the content-hash trigger for `statuses`; `statuses` itself is a fresh array each render
  useEffect(() => {
    if (!companionVisible) return undefined;
    const publish = (): void => {
      window.api.companionPublishStatuses(statuses);
      window.api.companionPublishPet(companionSelection);
    };
    publish();
    return window.api.onCompanionReplayRequest(publish);
  }, [key, companionVisible, companionSelection]);

  return null;
}
