import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Legacy format — pre-migration conversations stored deploymentId + agentName */
interface LegacyConversation {
  id: string;
  deploymentId?: string;
  agentName?: string;
  agentId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface McConversation {
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface McMessageImage {
  mediaType: string;
  data: string; // base64-encoded
}

export interface McMessage {
  id: string;
  role: 'user' | 'assistant';
  content:
    | { type: 'user'; text: string; images?: McMessageImage[] }
    | { type: 'assistant'; events: Record<string, unknown>[] };
  timestamp: string;
}

/**
 * Persists conversation metadata and message history to disk.
 * Not safe for concurrent access from multiple processes.
 */
export class ConversationStore {
  private readonly dir: string;
  private readonly indexPath: string;
  private indexLock: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'conversations');
    this.indexPath = join(this.dir, 'index.json');
  }

  private async loadIndex(): Promise<McConversation[]> {
    const raw = await readFile(this.indexPath, 'utf-8').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return '[]';
      throw e;
    });
    try {
      if (!raw.trim()) return [];
      return JSON.parse(raw) as McConversation[];
    } catch {
      return [];
    }
  }

  private saveIndex(conversations: McConversation[]): Promise<void> {
    // Serialize concurrent writes to prevent race conditions on the shared tmp file
    this.indexLock = this.indexLock.then(
      () => this.writeIndex(conversations),
      () => this.writeIndex(conversations),
    );
    return this.indexLock;
  }

  private async writeIndex(conversations: McConversation[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmpPath = `${this.indexPath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(conversations, null, 2));
    await rename(tmpPath, this.indexPath);
  }

  /**
   * Migrate legacy conversations that have deploymentId + agentName
   * to use agentId. Resolver maps agent name → agent ID.
   * Conversations with no resolvable agent are dropped.
   */
  async migrate(resolveAgentId: (agentName: string) => string | null): Promise<void> {
    const raw = await readFile(this.indexPath, 'utf-8').catch(() => '[]');
    if (!raw.trim()) return;
    let entries: LegacyConversation[];
    try {
      entries = JSON.parse(raw) as LegacyConversation[];
    } catch {
      return;
    }
    let changed = false;
    const migrated: McConversation[] = [];
    for (const entry of entries) {
      if (entry.agentId) {
        migrated.push(entry as McConversation);
        continue;
      }
      if (entry.agentName) {
        const id = resolveAgentId(entry.agentName);
        if (id) {
          migrated.push({
            id: entry.id,
            agentId: id,
            title: entry.title,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
          });
          changed = true;
          continue;
        }
      }
      // No agentId and can't resolve — drop the conversation
      changed = true;
    }
    if (changed) {
      await this.saveIndex(migrated);
    }
  }

  async create(agentId: string): Promise<McConversation> {
    const conversations = await this.loadIndex();
    const now = new Date().toISOString();
    const conversation: McConversation = {
      id: randomUUID(),
      agentId,
      title: 'New Conversation',
      createdAt: now,
      updatedAt: now,
    };
    conversations.push(conversation);
    await this.saveIndex(conversations);
    return conversation;
  }

  async listByAgent(agentId: string): Promise<McConversation[]> {
    const conversations = await this.loadIndex();
    return conversations.filter((c) => c.agentId === agentId);
  }

  async listAll(): Promise<McConversation[]> {
    return this.loadIndex();
  }

  async get(id: string): Promise<McConversation | null> {
    const conversations = await this.loadIndex();
    return conversations.find((c) => c.id === id) ?? null;
  }

  async rename(id: string, title: string): Promise<void> {
    const conversations = await this.loadIndex();
    const idx = conversations.findIndex((c) => c.id === id);
    if (idx !== -1) {
      conversations[idx].title = title;
      conversations[idx].updatedAt = new Date().toISOString();
      await this.saveIndex(conversations);
    }
  }

  async delete(id: string): Promise<void> {
    const conversations = await this.loadIndex();
    await this.saveIndex(conversations.filter((c) => c.id !== id));
    const messagesPath = join(this.dir, `${id}.jsonl`);
    await unlink(messagesPath).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }

  async appendMessage(conversationId: string, message: McMessage): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const messagesPath = join(this.dir, `${conversationId}.jsonl`);
    await writeFile(messagesPath, `${JSON.stringify(message)}\n`, { flag: 'a' });

    // Update index: updatedAt and title from first user message
    const conversations = await this.loadIndex();
    const idx = conversations.findIndex((c) => c.id === conversationId);
    if (idx !== -1) {
      conversations[idx].updatedAt = new Date().toISOString();
      if (
        conversations[idx].title === 'New Conversation' &&
        message.role === 'user' &&
        message.content.type === 'user'
      ) {
        conversations[idx].title = message.content.text.slice(0, 60);
      }
      await this.saveIndex(conversations);
    }
  }

  async getMessages(conversationId: string): Promise<McMessage[]> {
    const messagesPath = join(this.dir, `${conversationId}.jsonl`);
    const raw = await readFile(messagesPath, 'utf-8').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return '';
      throw e;
    });
    if (!raw) return [];
    return raw
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as McMessage);
  }
}
