import type { ConversationPage, MobileCapability } from '@dash/mobile-contract';
import { describe, expect, it, vi } from 'vitest';
import { ConversationController } from './conversation-controller.js';
import { FixtureGatewayConversationRepository } from './test-support/fixture-gateway-conversation-repository.js';

function legacyRepository(id = 'local-1') {
  const localPage: ConversationPage = {
    items: [
      {
        id,
        agentId: 'agent-1',
        agentName: 'Developer',
        title: 'Old local history',
        revision: 0,
        status: 'idle',
        activeTurnId: null,
        owningIssueId: null,
        projectId: null,
        lastSeq: 0,
        lastMessagePreview: 'local',
        createdAt: '2026-07-01T00:00:00Z',
        updatedAt: '2026-07-01T00:00:00Z',
      },
    ],
    nextCursor: null,
  };
  return {
    offline: false,
    list: vi.fn().mockResolvedValue(localPage),
    get: vi.fn(
      async (conversationId: string) =>
        localPage.items.find((item) => item.id === conversationId) ?? null,
    ),
    create: vi.fn().mockResolvedValue(localPage.items[0]),
    messages: vi.fn().mockResolvedValue({ items: [], nextCursor: null, throughSeq: 0 }),
    patch: vi.fn().mockResolvedValue(localPage.items[0]),
    rename: vi.fn().mockResolvedValue(localPage.items[0]),
    setLinkage: vi.fn().mockResolvedValue(localPage.items[0]),
    delete: vi.fn().mockResolvedValue({ ...localPage.items[0], status: 'deleted' }),
    replay: vi.fn().mockResolvedValue([]),
  };
}

describe('ConversationController', () => {
  it('uses gateway authority and appends read-only On this Mac history when capable', async () => {
    const gateway = await FixtureGatewayConversationRepository.load();
    const legacy = legacyRepository();
    const controller = new ConversationController(legacy);
    controller.configure({
      gatewayId: 'gateway-1',
      online: true,
      capabilities: ['conversation-sync-v1', 'chat-resume-v1'] as MobileCapability[],
      repository: gateway,
    });

    const result = await controller.list({ limit: 50 });
    expect(result.authority).toBe('gateway');
    expect(result.items.find((item) => item.origin === 'gateway')).toMatchObject({
      offline: false,
      readOnly: false,
    });
    expect(result.items.find((item) => item.origin === 'local')).toMatchObject({
      id: 'local-1',
      offline: false,
      readOnly: true,
    });

    await controller.create('agent-1', 'request-1');
    expect(gateway.calls.some((call) => call.method === 'create')).toBe(true);
    expect(legacy.create).not.toHaveBeenCalled();
  });

  it('uses only the writable legacy repository when capability is explicitly absent', async () => {
    const gateway = await FixtureGatewayConversationRepository.load();
    const legacy = legacyRepository();
    const controller = new ConversationController(legacy);
    controller.configure({
      gatewayId: 'gateway-1',
      online: true,
      capabilities: [],
      repository: gateway,
    });

    const result = await controller.list({ limit: 50 });
    expect(result).toMatchObject({ authority: 'legacy', gatewayOnline: true });
    expect(result.items).toEqual([
      expect.objectContaining({ id: 'local-1', origin: 'local', readOnly: false }),
    ]);
    await controller.create('agent-1', 'request-1');
    expect(legacy.create).toHaveBeenCalledOnce();
    expect(gateway.calls.some((call) => call.method === 'create')).toBe(false);
  });

  it('keeps a known capable gateway read-only while offline and never falls back to create', async () => {
    const gateway = await FixtureGatewayConversationRepository.load();
    gateway.setOffline(true);
    const legacy = legacyRepository();
    const controller = new ConversationController(legacy);
    controller.configure({
      gatewayId: 'gateway-1',
      online: false,
      capabilities: ['conversation-sync-v1'] as MobileCapability[],
      repository: gateway,
    });

    const result = await controller.list({ limit: 50 });
    expect(result.authority).toBe('gateway');
    expect(result.gatewayOnline).toBe(false);
    expect(result.items.every((item) => item.readOnly)).toBe(true);
    await expect(controller.create('agent-1', 'request-2')).rejects.toThrow('read-only');
    expect(legacy.create).not.toHaveBeenCalled();
  });

  it('treats an unverified offline profile as unresolved and local history as read-only', async () => {
    const legacy = legacyRepository();
    const controller = new ConversationController(legacy);
    controller.configure({ gatewayId: null, online: false, capabilities: null, repository: null });

    const result = await controller.list({ limit: 50 });
    expect(result).toMatchObject({ authority: 'unresolved', gatewayOnline: false });
    expect(result.items[0]).toMatchObject({ origin: 'local', readOnly: true });
    await expect(controller.create('agent-1', 'request-3')).rejects.toThrow('read-only');
  });

  it('rejects capable mutations for local history and never invokes the legacy writer', async () => {
    const gateway = await FixtureGatewayConversationRepository.load();
    const legacy = legacyRepository();
    const controller = new ConversationController(legacy);
    controller.configure({
      gatewayId: 'gateway-1',
      online: true,
      capabilities: ['conversation-sync-v1'],
      repository: gateway,
    });
    const local = { id: 'local-1', origin: 'local' as const };

    await expect(controller.rename(local, 0, 'No write')).rejects.toThrow(
      'On this Mac conversations are read-only',
    );
    await expect(controller.delete(local, 0)).rejects.toThrow(
      'On this Mac conversations are read-only',
    );
    await expect(controller.replay(local, 'agent-1', 0)).resolves.toEqual([]);
    expect(legacy.patch).not.toHaveBeenCalled();
    expect(legacy.delete).not.toHaveBeenCalled();
    expect(legacy.replay).not.toHaveBeenCalled();
  });

  it('routes a gateway-origin mutation by origin even when the legacy ID matches', async () => {
    const gateway = await FixtureGatewayConversationRepository.load();
    const gatewayPage = await gateway.list();
    const sharedId = gatewayPage.items[0].id;
    const legacy = legacyRepository(sharedId);
    const controller = new ConversationController(legacy);
    controller.configure({
      gatewayId: 'gateway-1',
      online: true,
      capabilities: ['conversation-sync-v1'],
      repository: gateway,
    });

    await controller.rename({ id: sharedId, origin: 'gateway' }, 2, 'Gateway title');

    expect(gateway.calls).toEqual(
      expect.arrayContaining([
        { method: 'patch', args: [sharedId, 2, { title: 'Gateway title' }] },
      ]),
    );
    expect(legacy.patch).not.toHaveBeenCalled();
    expect(legacy.rename).not.toHaveBeenCalled();
  });

  it('does not append local history on gateway continuation pages', async () => {
    const gateway = await FixtureGatewayConversationRepository.load();
    const legacy = legacyRepository();
    const controller = new ConversationController(legacy);
    controller.configure({
      gatewayId: 'gateway-1',
      online: true,
      capabilities: ['conversation-sync-v1'],
      repository: gateway,
    });

    const result = await controller.list({ limit: 50, cursor: 'opaque-next' });

    expect(result.items.some((item) => item.origin === 'local')).toBe(false);
    expect(legacy.list).not.toHaveBeenCalled();
  });
});
