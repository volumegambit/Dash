import { ConversationRepositoryOfflineError } from '@dash/mc';
import type {
  ConversationAuthorityMode,
  ConversationRef,
  ConversationRepository,
  McConversationListResult,
  McConversationView,
} from '@dash/mc';
import type {
  ConversationMessagePage,
  ConversationSummary,
  MobileCapability,
  ReplayEntry,
} from '@dash/mobile-contract';

export interface VerifiedGatewayContext {
  gatewayId: string | null;
  online: boolean;
  capabilities: MobileCapability[] | null;
  repository: ConversationRepository | null;
}

function view(
  item: ConversationSummary,
  origin: 'gateway' | 'local',
  offline: boolean,
  readOnly: boolean,
): McConversationView {
  return {
    ...item,
    origin,
    offline,
    readOnly: readOnly || item.status === 'archived' || item.status === 'deleted',
  };
}

export class ConversationController {
  private context: VerifiedGatewayContext = {
    gatewayId: null,
    online: false,
    capabilities: null,
    repository: null,
  };

  constructor(private readonly legacy: ConversationRepository) {}

  configure(context: VerifiedGatewayContext): void {
    this.context = context;
  }

  get authority(): ConversationAuthorityMode {
    if (this.context.capabilities === null) return 'unresolved';
    return this.context.capabilities.includes('conversation-sync-v1') ? 'gateway' : 'legacy';
  }

  async list(
    params: { agentId?: string; limit?: number; cursor?: string } = {},
  ): Promise<McConversationListResult> {
    const mode = this.authority;
    if (mode === 'legacy') {
      const page = await this.legacy.list(params);
      return {
        items: page.items.map((item) => view(item, 'local', false, false)),
        nextCursor: null,
        authority: mode,
        gatewayOnline: this.context.online,
      };
    }

    if (mode === 'unresolved') {
      const page = await this.legacy.list(params);
      return {
        items: page.items.map((item) => view(item, 'local', true, true)),
        nextCursor: null,
        authority: mode,
        gatewayOnline: false,
      };
    }

    const gateway = this.requiredGateway();
    const [gatewayPage, localPage] = await Promise.all([
      gateway.list(params),
      params.cursor ? Promise.resolve({ items: [], nextCursor: null }) : this.legacy.list(),
    ]);
    const offline = !this.context.online || gateway.offline;
    return {
      items: [
        ...gatewayPage.items.map((item) => view(item, 'gateway', offline, offline)),
        ...localPage.items.map((item) => view(item, 'local', offline, true)),
      ],
      nextCursor: gatewayPage.nextCursor,
      authority: mode,
      gatewayOnline: !offline,
    };
  }

  async find(ref: ConversationRef): Promise<McConversationView | null> {
    const repository = this.repository(ref.origin);
    const found = await repository.get(ref.id);
    if (!found || found.status === 'deleted') return null;
    const offline = ref.origin === 'gateway' && (!this.context.online || repository.offline);
    const readOnly = ref.origin === 'local' ? this.authority !== 'legacy' : offline;
    return view(found, ref.origin, offline, readOnly);
  }

  async create(
    agentId: string,
    requestId: string,
    metadata: Partial<Pick<ConversationSummary, 'title' | 'owningIssueId' | 'projectId'>> = {},
  ): Promise<McConversationView> {
    this.assertWritable();
    const origin = this.authority === 'gateway' ? 'gateway' : 'local';
    const created = await this.repository(origin).create(agentId, requestId, metadata);
    return view(created, origin, false, false);
  }

  async messages(
    ref: ConversationRef,
    params: { limit?: number; before?: string } = {},
  ): Promise<ConversationMessagePage> {
    return this.repository(ref.origin).messages(ref.id, params);
  }

  async patch(
    ref: ConversationRef,
    revision: number,
    patch: Partial<Pick<ConversationSummary, 'title' | 'owningIssueId' | 'projectId'>>,
  ): Promise<McConversationView> {
    this.assertWritableRef(ref);
    const updated = await this.repository(ref.origin).patch(ref.id, revision, patch);
    return view(updated, ref.origin, false, false);
  }

  async rename(ref: ConversationRef, revision: number, title: string): Promise<McConversationView> {
    return this.patch(ref, revision, { title });
  }

  async setLinkage(
    ref: ConversationRef,
    revision: number,
    linkage: Partial<Pick<ConversationSummary, 'owningIssueId' | 'projectId'>>,
  ): Promise<McConversationView> {
    return this.patch(ref, revision, linkage);
  }

  async delete(ref: ConversationRef, revision: number): Promise<void> {
    this.assertWritableRef(ref);
    await this.repository(ref.origin).delete(ref.id, revision);
  }

  replay(ref: ConversationRef, agentId: string, sinceSeq: number): Promise<ReplayEntry[]> {
    if (ref.origin !== 'gateway') return Promise.resolve([]);
    return this.requiredGateway().replay(agentId, ref.id, sinceSeq);
  }

  private repository(origin: 'gateway' | 'local'): ConversationRepository {
    return origin === 'gateway' ? this.requiredGateway() : this.legacy;
  }

  private requiredGateway(): ConversationRepository {
    if (!this.context.repository) throw new ConversationRepositoryOfflineError();
    return this.context.repository;
  }

  private assertWritable(): void {
    if (!this.context.online || this.authority === 'unresolved') {
      throw new ConversationRepositoryOfflineError();
    }
  }

  private assertWritableRef(ref: ConversationRef): void {
    this.assertWritable();
    if (this.authority === 'gateway' && ref.origin !== 'gateway') {
      throw new Error('On this Mac conversations are read-only with this gateway');
    }
    if (this.authority === 'legacy' && ref.origin !== 'local') {
      throw new Error('Gateway conversation is not available through this older gateway');
    }
  }
}
