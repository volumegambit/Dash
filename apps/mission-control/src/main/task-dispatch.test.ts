import type { ConversationRef } from '@dash/mc';
import { describe, expect, it, vi } from 'vitest';
import { assignAgentToTask, buildTaskKickoffPrompt } from './task-dispatch.js';

const gatewayConversation: ConversationRef = { id: 'shared-conversation', origin: 'gateway' };
const localConversation: ConversationRef = { id: 'shared-conversation', origin: 'local' };

function makeDeps(conversation: ConversationRef = gatewayConversation) {
  return {
    getIssue: vi.fn().mockResolvedValue({
      id: 'issue_1',
      key: 'TASK-2',
      title: 'Fix the thing',
      project_id: 'project-1',
    }),
    createConversation: vi.fn().mockResolvedValue(conversation),
    linkSession: vi.fn().mockResolvedValue(undefined),
    patchIssue: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe('buildTaskKickoffPrompt', () => {
  it('references the task key and title and the issues_* tools', () => {
    const prompt = buildTaskKickoffPrompt({ key: 'TASK-2', title: 'Fix the thing' });
    expect(prompt).toContain('TASK-2');
    expect(prompt).toContain('Fix the thing');
    expect(prompt).toContain('issues_read');
    expect(prompt).toContain('issues_comment');
    expect(prompt).toContain('waiting_on_human');
    expect(prompt).toContain('review');
  });
});

describe('assignAgentToTask', () => {
  it.each([gatewayConversation, localConversation])(
    'preserves the full $origin ref through link, send, and return',
    async (conversation) => {
      const deps = makeDeps(conversation);
      const order: string[] = [];
      deps.linkSession.mockImplementation(async () => {
        order.push('link');
      });
      deps.patchIssue.mockImplementation(async () => {
        order.push('patch');
      });
      deps.sendMessage.mockImplementation(async () => {
        order.push('send');
      });

      const result = await assignAgentToTask(
        deps,
        'issue_1',
        'agent-reg-id',
        'Developer',
        'request-123',
        'turn-456',
      );

      expect(result).toEqual(conversation);
      expect(deps.createConversation).toHaveBeenCalledWith('agent-reg-id', 'request-123', {
        title: 'TASK-2 — Fix the thing',
        owningIssueId: 'issue_1',
        projectId: 'project-1',
      });
      expect(deps.linkSession).toHaveBeenCalledWith('issue_1', conversation, 'Developer');
      expect(deps.patchIssue).toHaveBeenCalledWith('issue_1', {
        status: 'in_progress',
        sub_status: 'agent_working',
      });
      expect(deps.sendMessage).toHaveBeenCalledWith(
        conversation,
        'turn-456',
        buildTaskKickoffPrompt({ key: 'TASK-2', title: 'Fix the thing' }),
      );
      expect(order).toEqual(['link', 'patch', 'send']);
    },
  );

  it('omits a null project from canonical create metadata', async () => {
    const deps = makeDeps();
    deps.getIssue.mockResolvedValue({
      id: 'issue_2',
      key: 'TASK-3',
      title: 'Standalone task',
      project_id: null,
    });

    await assignAgentToTask(
      deps,
      'TASK-3',
      'agent-reg-id',
      'Developer',
      'request-null-project',
      'turn-null-project',
    );

    expect(deps.createConversation).toHaveBeenCalledWith('agent-reg-id', 'request-null-project', {
      title: 'TASK-3 — Standalone task',
      owningIssueId: 'issue_2',
    });
    expect(deps.createConversation.mock.calls[0][2]).not.toHaveProperty('projectId');
  });

  it('resolves the issue by id-or-key and dispatches against the resolved id', async () => {
    const deps = makeDeps();
    await assignAgentToTask(deps, 'TASK-2', 'agent-reg-id', 'Developer', 'request-key', 'turn-key');
    expect(deps.getIssue).toHaveBeenCalledWith('TASK-2');
    expect(deps.linkSession).toHaveBeenCalledWith('issue_1', gatewayConversation, 'Developer');
    expect(deps.patchIssue).toHaveBeenCalledWith('issue_1', expect.anything());
  });

  it('does not create a conversation when the issue lookup fails', async () => {
    const deps = makeDeps();
    deps.getIssue.mockRejectedValue(new Error('Issue not found'));
    await expect(
      assignAgentToTask(deps, 'issue_x', 'a', 'A', 'request-fail', 'turn-fail'),
    ).rejects.toThrow('Issue not found');
    expect(deps.createConversation).not.toHaveBeenCalled();
  });
});
