import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ConversationMessagePage,
  ConversationPage,
  ConversationSummary,
} from '@dash/mobile-contract';

interface GatewayConversationCacheDocument {
  schemaVersion: 1;
  gatewayId: string;
  conversations: Record<string, ConversationSummary>;
  listPages: Record<string, { ids: string[]; nextCursor: string | null }>;
  messagePages: Record<string, ConversationMessagePage>;
}

function pageKey(params: { agentId?: string; limit?: number; cursor?: string }): string {
  return JSON.stringify({
    agentId: params.agentId ?? null,
    limit: params.limit ?? 50,
    cursor: params.cursor ?? null,
  });
}

function messagePageKey(
  conversationId: string,
  params: { limit?: number; before?: string },
): string {
  return JSON.stringify({
    conversationId,
    limit: params.limit ?? 100,
    before: params.before ?? null,
  });
}

function empty(gatewayId: string): GatewayConversationCacheDocument {
  return {
    schemaVersion: 1,
    gatewayId,
    conversations: {},
    listPages: {},
    messagePages: {},
  };
}

const cacheWriteLocks = new Map<string, Promise<void>>();

function withCacheWriteLock(path: string, operation: () => Promise<void>): Promise<void> {
  const previous = cacheWriteLocks.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  cacheWriteLocks.set(path, next);
  const cleanup = (): void => {
    if (cacheWriteLocks.get(path) === next) cacheWriteLocks.delete(path);
  };
  void next.then(cleanup, cleanup);
  return next;
}

export class GatewayConversationCache {
  private readonly root: string;
  private readonly file: string;
  private readonly indexFile: string;

  constructor(
    dataDir: string,
    private readonly gatewayId: string,
  ) {
    const key = createHash('sha256').update(gatewayId).digest('hex');
    this.root = resolve(dataDir, 'gateway-conversations', key);
    this.file = resolve(this.root, 'cache.json');
    this.indexFile = resolve(dataDir, 'gateway-conversations', 'index.json');
  }

  private async read(): Promise<GatewayConversationCacheDocument> {
    const raw = await readFile(this.file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (!raw) return empty(this.gatewayId);
    const parsed = JSON.parse(raw) as GatewayConversationCacheDocument;
    if (parsed.schemaVersion !== 1 || parsed.gatewayId !== this.gatewayId) {
      return empty(this.gatewayId);
    }
    return parsed;
  }

  private write(mutate: (document: GatewayConversationCacheDocument) => void): Promise<void> {
    return withCacheWriteLock(this.indexFile, async () => {
      const document = await this.read();
      mutate(document);
      await mkdir(this.root, { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(document, null, 2));
      await rename(temporary, this.file);
      const indexRaw = await readFile(this.indexFile, 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        },
      );
      const index = indexRaw
        ? (JSON.parse(indexRaw) as { schemaVersion: 1; gateways: Record<string, string> })
        : { schemaVersion: 1 as const, gateways: {} };
      const key = createHash('sha256').update(this.gatewayId).digest('hex');
      index.gateways[key] = this.gatewayId;
      const indexTemporary = `${this.indexFile}.${randomUUID()}.tmp`;
      await writeFile(indexTemporary, JSON.stringify(index, null, 2));
      await rename(indexTemporary, this.indexFile);
    });
  }

  async putConversationPage(
    page: ConversationPage,
    params: { agentId?: string; limit?: number; cursor?: string },
  ): Promise<void> {
    await this.write((document) => {
      for (const item of page.items) document.conversations[item.id] = item;
      document.listPages[pageKey(params)] = {
        ids: page.items.map((item) => item.id),
        nextCursor: page.nextCursor,
      };
    });
  }

  async getConversationPage(params: {
    agentId?: string;
    limit?: number;
    cursor?: string;
  }): Promise<ConversationPage> {
    const document = await this.read();
    const stored = document.listPages[pageKey(params)];
    if (!stored) return { items: [], nextCursor: null };
    return {
      items: stored.ids.flatMap((id) => {
        const item = document.conversations[id];
        return item ? [item] : [];
      }),
      nextCursor: stored.nextCursor,
    };
  }

  async putConversation(conversation: ConversationSummary): Promise<void> {
    await this.write((document) => {
      document.conversations[conversation.id] = conversation;
    });
  }

  async putCreatedConversation(conversation: ConversationSummary): Promise<void> {
    await this.write((document) => {
      document.conversations[conversation.id] = conversation;
      for (const [key, page] of Object.entries(document.listPages)) {
        const query = JSON.parse(key) as {
          agentId: string | null;
          limit: number;
          cursor: string | null;
        };
        if (query.agentId !== null && query.agentId !== conversation.agentId) continue;
        if (query.cursor !== null) {
          delete document.listPages[key];
          continue;
        }
        page.ids = [conversation.id, ...page.ids.filter((id) => id !== conversation.id)].slice(
          0,
          query.limit,
        );
        page.nextCursor = null;
      }
    });
  }

  async getConversation(id: string): Promise<ConversationSummary | null> {
    return (await this.read()).conversations[id] ?? null;
  }

  async getConversationIds(): Promise<string[]> {
    return Object.keys((await this.read()).conversations).sort();
  }

  async putMessagePage(
    id: string,
    page: ConversationMessagePage,
    params: { limit?: number; before?: string } = {},
  ): Promise<void> {
    await this.write((document) => {
      document.messagePages[messagePageKey(id, params)] = page;
    });
  }

  async getMessagePage(
    id: string,
    params: { limit?: number; before?: string } = {},
  ): Promise<ConversationMessagePage> {
    return (
      (await this.read()).messagePages[messagePageKey(id, params)] ?? {
        items: [],
        nextCursor: null,
        throughSeq: 0,
      }
    );
  }

  async removeConversation(id: string): Promise<void> {
    await this.write((document) => {
      delete document.conversations[id];
      for (const key of Object.keys(document.messagePages)) {
        const parsed = JSON.parse(key) as { conversationId: string };
        if (parsed.conversationId === id) delete document.messagePages[key];
      }
      for (const page of Object.values(document.listPages)) {
        page.ids = page.ids.filter((itemId) => itemId !== id);
      }
    });
  }
}
