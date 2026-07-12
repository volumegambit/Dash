/**
 * "Assign an agent to a task" dispatch pipeline, extracted from the IPC
 * handler for testability (deps are injected, mirroring enrollGateway).
 *
 * Order matters: the session↔issue link is written BEFORE the kickoff
 * message so the Linked Sessions chip exists on the task page the moment
 * the agent starts, independent of whether the agent ever calls a
 * projects/issues tool (tool calls only link lazily).
 */

import type { ConversationRef } from '@dash/mc';

export interface TaskDispatchDeps {
  /** Resolve id or human key to the issue (throws/rejects when missing). */
  getIssue(
    idOrKey: string,
  ): Promise<{ id: string; key: string; title: string; project_id: string | null }>;
  createConversation(
    agentId: string,
    requestId: string,
    metadata: { title: string; owningIssueId: string; projectId?: string },
  ): Promise<ConversationRef>;
  linkSession(issueId: string, conversation: ConversationRef, agentName: string): Promise<unknown>;
  /** Only ever called with the dispatch patch — typed literally so the
   *  ManagementClient.patchIssue(Partial<Issue>) lambda needs no cast. */
  patchIssue(
    issueId: string,
    patch: { status: 'in_progress'; sub_status: 'agent_working' },
  ): Promise<unknown>;
  sendMessage(conversation: ConversationRef, turnId: string, text: string): Promise<void>;
}

export function buildTaskKickoffPrompt(issue: { key: string; title: string }): string {
  return [
    `You've been assigned task ${issue.key}: "${issue.title}".`,
    '',
    `Start by calling issues_read with id_or_key "${issue.key}" to load the full task — description, comments, and subtasks. Then do the work it describes.`,
    '',
    'As you work:',
    '- Post progress updates with issues_comment.',
    '- If you are blocked or need a human decision, set sub_status "waiting_on_human" via issues_update and explain what you need in a comment.',
    '- When the work is complete, set status "review" via issues_update and post a summary comment of what you did.',
  ].join('\n');
}

/**
 * Dispatch an agent onto a task. `agentId` is the registry id (chat
 * addressing); `agentName` is the agent's config.name — the key
 * session_issue_link and the agents_involved filter use. Returns the new
 * conversation reference without discarding its authority origin.
 */
export async function assignAgentToTask(
  deps: TaskDispatchDeps,
  issueIdOrKey: string,
  agentId: string,
  agentName: string,
  requestId: string,
  turnId: string,
): Promise<ConversationRef> {
  const issue = await deps.getIssue(issueIdOrKey);
  const title = `${issue.key} — ${issue.title}`;
  const conversation = await deps.createConversation(agentId, requestId, {
    title,
    owningIssueId: issue.id,
    ...(issue.project_id === null ? {} : { projectId: issue.project_id }),
  });
  await deps.linkSession(issue.id, conversation, agentName);
  await deps.patchIssue(issue.id, { status: 'in_progress', sub_status: 'agent_working' });
  await deps.sendMessage(conversation, turnId, buildTaskKickoffPrompt(issue));
  return conversation;
}
