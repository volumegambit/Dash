import type {
  ConversationContent,
  ConversationMessage,
  ConversationMessagePage,
  ConversationPage,
  ConversationSummary,
  MobileAgentEvent,
  MobileImage,
  MobileImageMediaType,
  ReplayEntry,
} from '@dash/mobile-contract';
import type { ConversationRepository } from './conversation-repository.js';
import type { ConversationStore, McConversation, McMessage } from './conversations.js';

function summary(record: McConversation, agentName: string): ConversationSummary {
  return {
    id: record.id,
    agentId: record.agentId,
    agentName,
    title: record.title,
    revision: 0,
    status: 'idle',
    activeTurnId: null,
    owningIssueId: record.issueId ?? null,
    projectId: null,
    lastSeq: 0,
    lastMessagePreview: '',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

const MOBILE_IMAGE_TYPES = new Set<MobileImageMediaType>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export function toCanonicalLegacyContent(record: McMessage): ConversationContent {
  if (record.content.type === 'user') {
    const images = (record.content.images ?? []).flatMap((image): MobileImage[] =>
      MOBILE_IMAGE_TYPES.has(image.mediaType as MobileImageMediaType)
        ? [{ mediaType: image.mediaType as MobileImageMediaType, data: image.data }]
        : [],
    );
    return {
      type: 'user',
      text: record.content.text,
      ...(images.length > 0 ? { images } : {}),
    };
  }
  const events = record.content.events.filter(
    (event): event is MobileAgentEvent => typeof event.type === 'string',
  );
  return { type: 'assistant', events };
}

function message(record: McMessage, conversationId: string, ordinal: number): ConversationMessage {
  return {
    id: record.id,
    conversationId,
    turnId: `legacy:${record.id}`,
    ordinal,
    role: record.role,
    status: 'completed',
    content: toCanonicalLegacyContent(record),
    createdAt: record.timestamp,
    updatedAt: record.timestamp,
  };
}

export class LegacyConversationRepository implements ConversationRepository {
  readonly offline = false;

  constructor(
    private readonly store: ConversationStore,
    private readonly resolveAgentName: (agentId: string) => string,
  ) {}

  async list(): Promise<ConversationPage> {
    const records = await this.store.listAll();
    return {
      items: records.map((record) => summary(record, this.resolveAgentName(record.agentId))),
      nextCursor: null,
    };
  }

  async get(id: string): Promise<ConversationSummary | null> {
    const record = await this.store.get(id);
    return record ? summary(record, this.resolveAgentName(record.agentId)) : null;
  }

  async create(
    agentId: string,
    _requestId: string,
    metadata: Partial<Pick<ConversationSummary, 'title' | 'owningIssueId' | 'projectId'>> = {},
  ): Promise<ConversationSummary> {
    const record = await this.store.create(agentId);
    if (metadata.title !== undefined) await this.store.rename(record.id, metadata.title);
    if (typeof metadata.owningIssueId === 'string') {
      await this.store.setIssueId(record.id, metadata.owningIssueId);
    }
    const updated = await this.store.get(record.id);
    if (!updated) throw new Error(`Conversation "${record.id}" not found after create`);
    return summary(updated, this.resolveAgentName(updated.agentId));
  }

  async messages(id: string): Promise<ConversationMessagePage> {
    const records = await this.store.getMessages(id);
    return {
      items: records.map((record, index) => message(record, id, index + 1)),
      nextCursor: null,
      throughSeq: 0,
    };
  }

  async patch(
    id: string,
    _revision: number,
    patch: Partial<Pick<ConversationSummary, 'title' | 'owningIssueId' | 'projectId'>>,
  ): Promise<ConversationSummary> {
    if (patch.title !== undefined) await this.store.rename(id, patch.title);
    if (patch.owningIssueId) await this.store.setIssueId(id, patch.owningIssueId);
    const updated = await this.get(id);
    if (!updated) throw new Error(`Conversation "${id}" not found`);
    return updated;
  }

  async rename(id: string, revision: number, title: string): Promise<ConversationSummary> {
    return this.patch(id, revision, { title });
  }

  async setLinkage(
    id: string,
    revision: number,
    linkage: Partial<Pick<ConversationSummary, 'owningIssueId' | 'projectId'>>,
  ): Promise<ConversationSummary> {
    return this.patch(id, revision, linkage);
  }

  async delete(id: string): Promise<ConversationSummary> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Conversation "${id}" not found`);
    await this.store.delete(id);
    return { ...existing, status: 'deleted', deletedAt: new Date().toISOString() };
  }

  async replay(): Promise<ReplayEntry[]> {
    return [];
  }
}
