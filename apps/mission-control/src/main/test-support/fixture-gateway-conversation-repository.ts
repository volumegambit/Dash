import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConversationRepository } from '@dash/mc';
import { ConversationRepositoryOfflineError, GatewayHttpError } from '@dash/mc';
import type {
  ConversationMessagePage,
  ConversationPage,
  ConversationSummary,
  MobileApiError,
  ReplayEntry,
  ReplayPage,
} from '@dash/mobile-contract';

async function json<T>(name: string): Promise<T> {
  const root = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../contracts/mobile/v1/fixtures',
  );
  return JSON.parse(await readFile(resolve(root, name), 'utf8')) as T;
}

function fixtureStatus(code: MobileApiError['code']): number {
  return {
    unauthorized: 401,
    not_found: 404,
    validation_failed: 400,
    revision_conflict: 409,
    conversation_busy: 409,
    rate_limited: 429,
    gateway_offline: 502,
    capability_required: 426,
  }[code];
}

export class FixtureGatewayConversationRepository implements ConversationRepository {
  offline = false;
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  private failure: { status: number; error: MobileApiError } | null = null;

  private constructor(
    private page: ConversationPage,
    private messagePage: ConversationMessagePage,
    private replayEntries: ReplayEntry[],
  ) {}

  static async load(): Promise<FixtureGatewayConversationRepository> {
    return new FixtureGatewayConversationRepository(
      await json<ConversationPage>('conversations-page.json'),
      await json<ConversationMessagePage>('conversation-messages-page.json'),
      (await json<ReplayPage>('replay.json')).entries,
    );
  }

  failWith(error: MobileApiError | null): void {
    this.failure = error ? { status: fixtureStatus(error.code), error } : null;
  }

  setOffline(offline: boolean): void {
    this.offline = offline;
  }

  private check(label: string): void {
    if (this.offline) throw new ConversationRepositoryOfflineError();
    if (this.failure) {
      throw new GatewayHttpError(
        this.failure.status,
        label,
        JSON.stringify(this.failure.error),
        this.failure.error,
      );
    }
  }

  async list(params = {}): Promise<ConversationPage> {
    this.calls.push({ method: 'list', args: [params] });
    return this.page;
  }

  async get(id: string): Promise<ConversationSummary | null> {
    this.calls.push({ method: 'get', args: [id] });
    return this.page.items.find((item) => item.id === id) ?? null;
  }

  async create(agentId: string, requestId: string): Promise<ConversationSummary> {
    this.check('create');
    this.calls.push({ method: 'create', args: [agentId, requestId] });
    return this.page.items[0];
  }

  async messages(id: string): Promise<ConversationMessagePage> {
    this.calls.push({ method: 'messages', args: [id] });
    return this.messagePage;
  }

  async patch(
    id: string,
    revision: number,
    patch: Partial<Pick<ConversationSummary, 'title' | 'owningIssueId' | 'projectId'>>,
  ): Promise<ConversationSummary> {
    this.check('patch');
    this.calls.push({ method: 'patch', args: [id, revision, patch] });
    return { ...(await this.required(id)), ...patch, revision: revision + 1 };
  }

  async rename(id: string, revision: number, title: string): Promise<ConversationSummary> {
    this.check('rename');
    this.calls.push({ method: 'rename', args: [id, revision, title] });
    return this.patch(id, revision, { title });
  }

  async setLinkage(
    id: string,
    revision: number,
    linkage: Partial<Pick<ConversationSummary, 'owningIssueId' | 'projectId'>>,
  ): Promise<ConversationSummary> {
    this.check('setLinkage');
    this.calls.push({ method: 'setLinkage', args: [id, revision, linkage] });
    return this.patch(id, revision, linkage);
  }

  async delete(id: string, revision: number): Promise<ConversationSummary> {
    this.check('delete');
    this.calls.push({ method: 'delete', args: [id, revision] });
    return {
      ...(await this.required(id)),
      revision: revision + 1,
      status: 'deleted',
      deletedAt: '2026-07-12T00:00:00Z',
    };
  }

  async replay(agentId: string, conversationId: string, sinceSeq: number): Promise<ReplayEntry[]> {
    this.calls.push({ method: 'replay', args: [agentId, conversationId, sinceSeq] });
    return this.replayEntries.filter((entry) => entry.seq > sinceSeq);
  }

  private async required(id: string): Promise<ConversationSummary> {
    const conversation = await this.get(id);
    if (!conversation) throw new Error(`Fixture conversation "${id}" not found`);
    return conversation;
  }
}
