import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationAutoTitleService } from './conversation-auto-title.js';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import { DEFAULT_CONVERSATION_TITLE } from './conversation-service.js';

describe('ConversationAutoTitleService', () => {
  let tmpDir: string;
  let service: SqliteConversationService;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'conversation-auto-title-'));
    service = new SqliteConversationService({ dataDir: tmpDir });
  });

  afterEach(async () => {
    service.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createConversation(requestId = 'create-01') {
    return service.create({
      agentId: 'agent-01',
      agentName: 'Helper',
      requestId,
    });
  }

  it('replaces the default title once and emits the changed summary', async () => {
    const conversation = createConversation();
    const onChanged = vi.fn();
    const generateTitle = vi.fn().mockResolvedValue('Japan itinerary');
    const titles = createConversationAutoTitleService({
      conversations: service,
      generateTitle,
      onChanged,
    });

    titles.schedule({
      conversationId: conversation.id,
      agentId: 'agent-01',
      text: 'Plan a trip to Japan',
    });
    await titles.flush();

    expect(generateTitle).toHaveBeenCalledWith({
      agentId: 'agent-01',
      text: 'Plan a trip to Japan',
    });
    expect(service.get(conversation.id)).toMatchObject({
      title: 'Japan itinerary',
      revision: 2,
    });
    expect(onChanged).toHaveBeenCalledWith(
      expect.objectContaining({ id: conversation.id, title: 'Japan itinerary', revision: 2 }),
    );
  });

  it('deduplicates schedules while one title job is pending', async () => {
    let release!: (title: string) => void;
    const generated = new Promise<string>((resolve) => {
      release = resolve;
    });
    const generateTitle = vi.fn(() => generated);
    const titles = createConversationAutoTitleService({ conversations: service, generateTitle });
    const conversation = createConversation();

    titles.schedule({
      conversationId: conversation.id,
      agentId: 'agent-01',
      text: 'First opening text',
    });
    titles.schedule({
      conversationId: conversation.id,
      agentId: 'agent-01',
      text: 'Duplicate opening text',
    });
    expect(generateTitle).toHaveBeenCalledTimes(1);
    release('Only title');
    await titles.flush();
    expect(service.get(conversation.id)?.title).toBe('Only title');
  });

  it('contains generation failures, logs them, and permits a later retry', async () => {
    const conversation = createConversation();
    const warn = vi.fn();
    const generateTitle = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce('Recovered title');
    const titles = createConversationAutoTitleService({
      conversations: service,
      generateTitle,
      logger: { warn },
    });

    titles.schedule({ conversationId: conversation.id, agentId: 'agent-01', text: 'First try' });
    await expect(titles.flush()).resolves.toBeUndefined();
    expect(service.get(conversation.id)?.title).toBe(DEFAULT_CONVERSATION_TITLE);
    expect(warn).toHaveBeenCalledWith('conversation auto-title failed', {
      conversationId: conversation.id,
      error: 'provider unavailable',
    });

    titles.schedule({ conversationId: conversation.id, agentId: 'agent-01', text: 'Retry' });
    await titles.flush();
    expect(generateTitle).toHaveBeenCalledTimes(2);
    expect(service.get(conversation.id)?.title).toBe('Recovered title');
  });

  it('does not overwrite a manual rename that wins the race', async () => {
    let release!: (title: string) => void;
    const generated = new Promise<string>((resolve) => {
      release = resolve;
    });
    const conversation = createConversation();
    const onChanged = vi.fn();
    const titles = createConversationAutoTitleService({
      conversations: service,
      generateTitle: () => generated,
      onChanged,
    });
    titles.schedule({
      conversationId: conversation.id,
      agentId: 'agent-01',
      text: 'Plan a trip',
    });
    service.update(conversation.id, 1, { title: 'My Japan Trip' });
    release('Japan itinerary');
    await titles.flush();

    expect(service.get(conversation.id)?.title).toBe('My Japan Trip');
    expect(onChanged).not.toHaveBeenCalled();
  });
});
