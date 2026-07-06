import { describe, expect, it, vi } from 'vitest';
import { assignAgentToTask, buildTaskKickoffPrompt } from './task-dispatch.js';

function makeDeps() {
  return {
    getIssue: vi.fn().mockResolvedValue({ id: 'issue_1', key: 'TASK-2', title: 'Fix the thing' }),
    createConversation: vi.fn().mockResolvedValue({ id: 'conv-42' }),
    linkSession: vi.fn().mockResolvedValue(undefined),
    setIssueId: vi.fn().mockResolvedValue(undefined),
    patchIssue: vi.fn().mockResolvedValue(undefined),
    renameConversation: vi.fn().mockResolvedValue(undefined),
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
  it('links the session BEFORE kicking off the agent, and returns the conversation id', async () => {
    const deps = makeDeps();
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

    const conversationId = await assignAgentToTask(deps, 'issue_1', 'agent-reg-id', 'Developer');

    expect(conversationId).toBe('conv-42');
    expect(deps.createConversation).toHaveBeenCalledWith('agent-reg-id');
    // Link keyed on agent NAME (session_issue_link contract), not registry id.
    expect(deps.linkSession).toHaveBeenCalledWith('issue_1', 'conv-42', 'Developer');
    expect(deps.setIssueId).toHaveBeenCalledWith('conv-42', 'issue_1');
    expect(deps.patchIssue).toHaveBeenCalledWith('issue_1', {
      status: 'in_progress',
      sub_status: 'agent_working',
    });
    expect(deps.renameConversation).toHaveBeenCalledWith('conv-42', 'TASK-2 — Fix the thing');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'conv-42',
      buildTaskKickoffPrompt({ key: 'TASK-2', title: 'Fix the thing' }),
    );
    // The chip must exist before the agent starts streaming.
    expect(order).toEqual(['link', 'patch', 'send']);
  });

  it('resolves the issue by id-or-key and dispatches against the resolved id', async () => {
    const deps = makeDeps();
    await assignAgentToTask(deps, 'TASK-2', 'agent-reg-id', 'Developer');
    expect(deps.getIssue).toHaveBeenCalledWith('TASK-2');
    expect(deps.linkSession).toHaveBeenCalledWith('issue_1', 'conv-42', 'Developer');
    expect(deps.patchIssue).toHaveBeenCalledWith('issue_1', expect.anything());
  });

  it('does not create a conversation when the issue lookup fails', async () => {
    const deps = makeDeps();
    deps.getIssue.mockRejectedValue(new Error('Issue not found'));
    await expect(assignAgentToTask(deps, 'issue_x', 'a', 'A')).rejects.toThrow('Issue not found');
    expect(deps.createConversation).not.toHaveBeenCalled();
  });
});
