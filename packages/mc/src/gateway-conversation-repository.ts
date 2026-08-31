import type {
  ConversationMessagePage,
  ConversationPage,
  ConversationSummary,
  ReplayEntry,
} from '@dash/mobile-contract';
import type { ConversationRef, ConversationRepository } from './conversation-repository.js';
import { ConversationRepositoryOfflineError } from './conversation-repository.js';
import type { GatewayConversationCache } from './gateway-conversation-cache.js';
import { GatewayHttpError, type GatewayManagementClient } from './runtime/gateway-client.js';

type ConversationClient = Pick<
  GatewayManagementClient,
  | 'listConversations'
  | 'getConversation'
  | 'createConversation'
  | 'getConversationMessages'
  | 'patchConversation'
  | 'deleteConversation'
  | 'replayConversationEvents'
>;

function isNetworkFailure(error: unknown): boolean {
  if (error instanceof GatewayHttpError) {
    return error.status === 502 || error.apiError?.code === 'gateway_offline';
  }
  if (error instanceof SyntaxError) return false;
  if (error instanceof TypeError) return true;
  return error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name);
}

const RECONCILIATION_CONCURRENCY = 4;

export class GatewayConversationRepository implements ConversationRepository {
  offline = false;
  private needsReconciliation = true;

  constructor(
    readonly gatewayId: string,
    private readonly client: ConversationClient,
    private readonly cache: GatewayConversationCache,
    private readonly onDeleted: (conversation: ConversationRef) => void = () => {},
  ) {}

  private async purgeDeletedConversation(id: string): Promise<void> {
    await this.cache.removeConversation(id);
    this.onDeleted({ id, origin: 'gateway' });
  }

  private async reconcileAbsentCachedConversations(
    page: ConversationPage,
    params: { agentId?: string; limit?: number; cursor?: string },
  ): Promise<boolean | null> {
    if (params.cursor !== undefined || params.agentId !== undefined) return null;
    const visibleIds = new Set(page.items.map((item) => item.id));
    const cachedIds = await this.cache.getConversationIds();
    const omittedIds = cachedIds.filter((id) => !visibleIds.has(id));
    let complete = true;
    for (let index = 0; index < omittedIds.length; index += RECONCILIATION_CONCURRENCY) {
      const batch = omittedIds.slice(index, index + RECONCILIATION_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (id) => {
          let conversation: ConversationSummary;
          try {
            conversation = await this.client.getConversation(id);
          } catch (error) {
            if (error instanceof GatewayHttpError && error.status === 404) {
              await this.purgeDeletedConversation(id);
              return true;
            }
            return false;
          }
          if (conversation.status === 'deleted') {
            await this.purgeDeletedConversation(id);
          } else {
            await this.cache.putConversation(conversation);
          }
          return true;
        }),
      );
      if (results.includes(false)) {
        complete = false;
      }
    }
    return complete;
  }

  private markOffline(): void {
    this.offline = true;
    this.needsReconciliation = true;
  }

  private async reconcileAfterList(
    page: ConversationPage,
    params: { agentId?: string; limit?: number; cursor?: string },
    shouldReconcile: boolean,
  ): Promise<void> {
    if (!shouldReconcile) return;
    const complete = await this.reconcileAbsentCachedConversations(page, params);
    if (complete !== null) {
      this.needsReconciliation = !complete;
    }
  }

  private async readThrough<T>(online: () => Promise<T>, cached: () => Promise<T>): Promise<T> {
    try {
      const value = await online();
      this.offline = false;
      return value;
    } catch (error) {
      if (!isNetworkFailure(error)) throw error;
      this.markOffline();
      return cached();
    }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.offline) throw new ConversationRepositoryOfflineError();
    try {
      return await operation();
    } catch (error) {
      if (!isNetworkFailure(error)) throw error;
      this.markOffline();
      throw new ConversationRepositoryOfflineError();
    }
  }

  async list(
    params: { agentId?: string; limit?: number; cursor?: string } = {},
  ): Promise<ConversationPage> {
    const shouldReconcile = this.needsReconciliation || this.offline;
    return this.readThrough(
      async () => {
        const page = await this.client.listConversations(params);
        await this.cache.putConversationPage(page, params);
        await this.reconcileAfterList(page, params, shouldReconcile);
        return page;
      },
      () => this.cache.getConversationPage(params),
    );
  }

  async get(id: string): Promise<ConversationSummary | null> {
    return this.readThrough(
      async () => {
        try {
          const conversation = await this.client.getConversation(id);
          if (conversation.status === 'deleted') {
            await this.purgeDeletedConversation(id);
            return null;
          }
          await this.cache.putConversation(conversation);
          return conversation;
        } catch (error) {
          if (error instanceof GatewayHttpError && error.status === 404) {
            await this.purgeDeletedConversation(id);
            return null;
          }
          throw error;
        }
      },
      async () => {
        const cached = await this.cache.getConversation(id);
        if (cached?.status === 'deleted') {
          await this.cache.removeConversation(id);
          return null;
        }
        return cached;
      },
    );
  }

  async create(
    agentId: string,
    requestId: string,
    metadata: Partial<Pick<ConversationSummary, 'title' | 'owningIssueId' | 'projectId'>> = {},
  ): Promise<ConversationSummary> {
    return this.mutate(async () => {
      const conversation = await this.client.createConversation(agentId, requestId, metadata);
      await this.cache.putCreatedConversation(conversation);
      return conversation;
    });
  }

  async messages(
    id: string,
    params: { limit?: number; before?: string } = {},
  ): Promise<ConversationMessagePage> {
    return this.readThrough(
      async () => {
        const page = await this.client.getConversationMessages(id, params);
        await this.cache.putMessagePage(id, page, params);
        return page;
      },
      () => this.cache.getMessagePage(id, params),
    );
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

  async patch(
    id: string,
    revision: number,
    patch: Partial<Pick<ConversationSummary, 'title' | 'owningIssueId' | 'projectId'>>,
  ): Promise<ConversationSummary> {
    return this.mutate(async () => {
      const conversation = await this.client.patchConversation(id, revision, patch);
      await this.cache.putConversation(conversation);
      return conversation;
    });
  }

  async delete(id: string, revision: number): Promise<ConversationSummary> {
    return this.mutate(async () => {
      const tombstone = await this.client.deleteConversation(id, revision);
      await this.cache.removeConversation(id);
      return tombstone;
    });
  }

  async replay(agentId: string, conversationId: string, sinceSeq: number): Promise<ReplayEntry[]> {
    try {
      const page = await this.client.replayConversationEvents(agentId, conversationId, sinceSeq);
      this.offline = false;
      return page.entries;
    } catch (error) {
      if (!isNetworkFailure(error)) throw error;
      this.markOffline();
      throw new ConversationRepositoryOfflineError();
    }
  }

  async invalidate(id: string, deleted: boolean): Promise<void> {
    if (deleted) await this.cache.removeConversation(id);
  }
}
