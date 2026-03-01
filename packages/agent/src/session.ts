import { existsSync } from 'node:fs';
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContentBlock } from '@dash/llm';
import type { Session, SessionEntry, SessionStore } from './types.js';

export class JsonlSessionStore implements SessionStore {
  constructor(private baseDir: string) {}

  private sessionDir(channelId: string, conversationId: string): string {
    return join(this.baseDir, channelId, conversationId);
  }

  private sessionFile(channelId: string, conversationId: string): string {
    return join(this.sessionDir(channelId, conversationId), 'session.jsonl');
  }

  async load(channelId: string, conversationId: string): Promise<Session | null> {
    const file = this.sessionFile(channelId, conversationId);
    if (!existsSync(file)) return null;

    const content = await readFile(file, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    const session: Session = {
      id: `${channelId}:${conversationId}`,
      channelId,
      conversationId,
      createdAt: new Date().toISOString(),
      messages: [],
    };

    for (const line of lines) {
      const entry: SessionEntry = JSON.parse(line);
      if (entry.type === 'message') {
        session.messages.push({
          role: entry.data.role as 'user' | 'assistant',
          content: entry.data.content as string,
        });
        if (!session.createdAt || entry.timestamp < session.createdAt) {
          session.createdAt = entry.timestamp;
        }
      } else if (entry.type === 'response') {
        // Content can be string or ContentBlock[]
        const content = entry.data.content;
        session.messages.push({
          role: 'assistant',
          content: content as string | ContentBlock[],
        });
      } else if (entry.type === 'tool_result') {
        // Tool result entries store ContentBlock[] in data.content
        const content = entry.data.content;
        session.messages.push({
          role: 'user',
          content: content as ContentBlock[],
        });
      }
    }

    return session;
  }

  async save(_session: Session): Promise<void> {
    // save is a no-op — we use append-only
  }

  async append(sessionId: string, entry: SessionEntry): Promise<void> {
    const [channelId, conversationId] = sessionId.split(':');
    const dir = this.sessionDir(channelId, conversationId);
    await mkdir(dir, { recursive: true });
    const file = this.sessionFile(channelId, conversationId);
    await appendFile(file, JSON.stringify(entry) + '\n');
  }
}
