import type { MobileV2WsServerFrame } from '@dash/mobile-contract-v2';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatV2CommandIssue, MissionControlAPI } from '../shared/ipc.js';

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('electron', () => electron);

const conversation = {
  id: '00000000-0000-4000-8000-000000000001',
  origin: 'gateway' as const,
};

async function exposedApi(): Promise<MissionControlAPI> {
  await import('./index.js');
  return electron.contextBridge.exposeInMainWorld.mock.calls[0][1] as MissionControlAPI;
}

describe('Mission Control preload chat v2 bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    electron.contextBridge.exposeInMainWorld.mockReset();
    electron.ipcRenderer.invoke.mockReset().mockResolvedValue({ ok: true, value: undefined });
    electron.ipcRenderer.send.mockReset();
    electron.ipcRenderer.on.mockReset();
    electron.ipcRenderer.removeListener.mockReset();
  });

  it('passes renderer identities unchanged through v2 command methods', async () => {
    const api = await exposedApi();
    const enqueue = {
      commandId: '00000000-0000-4000-8000-000000000301',
      inputId: '00000000-0000-4000-8000-000000000302',
      behavior: 'steer' as const,
      expectedActiveTurnId: 'turn-01',
      text: 'focus the answer',
      images: [],
    };

    await api.chatGetInitialState(conversation);
    await api.chatGetOlderMessages(conversation, 'older-cursor', 50);
    await api.chatSubscribeV2(conversation, 12);
    await api.chatUnsubscribeV2(conversation);
    await api.chatEnqueueInput(conversation, enqueue);
    await api.chatEditFollowUp(conversation, {
      commandId: enqueue.commandId,
      inputId: enqueue.inputId,
      expectedRevision: 2,
      text: 'edited',
    });
    await api.chatRemoveFollowUp(conversation, enqueue.commandId, enqueue.inputId, 3);
    await api.chatResumeFollowUps(conversation, enqueue.commandId, 4);
    api.chatCancel(conversation, 'turn-01', 'cancel-token');
    api.chatAnswerQuestion(conversation, 'turn-01', 'question-1', 'Yes', 'answer-token');

    expect(electron.ipcRenderer.invoke.mock.calls).toEqual(
      expect.arrayContaining([
        ['chat:getInitialState', conversation],
        ['chat:getOlderMessages', conversation, 'older-cursor', 50],
        ['chat:subscribeV2', conversation, 12],
        ['chat:unsubscribeV2', conversation],
        ['chat:enqueueInput', conversation, enqueue],
        [
          'chat:editFollowUp',
          conversation,
          {
            commandId: enqueue.commandId,
            inputId: enqueue.inputId,
            expectedRevision: 2,
            text: 'edited',
          },
        ],
        ['chat:removeFollowUp', conversation, enqueue.commandId, enqueue.inputId, 3],
        ['chat:resumeFollowUps', conversation, enqueue.commandId, 4],
      ]),
    );
    expect(electron.ipcRenderer.send).toHaveBeenNthCalledWith(
      1,
      'chat:cancel',
      conversation,
      'turn-01',
      'cancel-token',
    );
    expect(electron.ipcRenderer.send).toHaveBeenNthCalledWith(
      2,
      'chat:answer-question',
      conversation,
      'turn-01',
      'question-1',
      'Yes',
      'answer-token',
    );
  });

  it.each([
    [
      'onChatV2Frame',
      'chat:v2Frame',
      {
        type: 'queue_paused',
        conversationId: conversation.id,
        v2Seq: 13,
        queueRevision: 4,
        queuePaused: true,
        pendingFollowUpCount: 2,
      } satisfies MobileV2WsServerFrame,
    ],
    [
      'onChatV2CommandError',
      'chat:v2CommandError',
      {
        conversation,
        commandId: 'turn-01',
        kind: 'answer',
        localDispatchToken: 'answer-token',
        questionId: 'question-1',
        ambiguousCorrelation: false,
        apiError: { code: 'conversation_busy', error: 'Busy', retryable: true },
      } satisfies ChatV2CommandIssue,
    ],
  ] as const)(
    'forwards and removes %s with the same listener',
    async (method, channel, payload) => {
      const api = await exposedApi();
      const callback = vi.fn();
      const remove = api[method](callback as never);
      const listener = electron.ipcRenderer.on.mock.calls.find(([name]) => name === channel)?.[1];

      expect(listener).toBeTypeOf('function');
      listener({} as Electron.IpcRendererEvent, payload);
      expect(callback).toHaveBeenCalledWith(payload);

      remove();
      expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(channel, listener);
    },
  );
});
