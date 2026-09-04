import type {
  ConversationMessagePage,
  ConversationPage,
  ConversationSummary,
  ReplayEntry,
} from '@dash/mobile-contract';

export type ConversationOrigin = 'gateway' | 'local';

export interface ConversationRef {
  id: string;
  origin: ConversationOrigin;
}

export type McConversationView = ConversationSummary & {
  origin: ConversationOrigin;
  offline: boolean;
  readOnly: boolean;
};

export type ConversationAuthorityMode = 'gateway' | 'legacy' | 'unresolved';

export interface McConversationListResult {
  items: McConversationView[];
  nextCursor: string | null;
  authority: ConversationAuthorityMode;
  gatewayOnline: boolean;
}

export interface ConversationRepository {
  readonly offline: boolean;
  list(params?: { agentId?: string; limit?: number; cursor?: string }): Promise<ConversationPage>;
  get(id: string): Promise<ConversationSummary | null>;
  create(
    agentId: string,
    requestId: string,
    metadata?: Partial<Pick<ConversationSummary, 'title' | 'owningIssueId' | 'projectId'>>,
  ): Promise<ConversationSummary>;
  messages(
    id: string,
    params?: { limit?: number; before?: string },
  ): Promise<ConversationMessagePage>;
  patch(
    id: string,
    revision: number,
    patch: Partial<Pick<ConversationSummary, 'title' | 'owningIssueId' | 'projectId'>>,
  ): Promise<ConversationSummary>;
  rename(id: string, revision: number, title: string): Promise<ConversationSummary>;
  setLinkage(
    id: string,
    revision: number,
    linkage: Partial<Pick<ConversationSummary, 'owningIssueId' | 'projectId'>>,
  ): Promise<ConversationSummary>;
  delete(id: string, revision: number): Promise<ConversationSummary>;
  replay(agentId: string, conversationId: string, sinceSeq: number): Promise<ReplayEntry[]>;
}

export class ConversationRepositoryOfflineError extends Error {
  constructor(message = 'Gateway offline — cached conversations are read-only') {
    super(message);
    this.name = 'ConversationRepositoryOfflineError';
  }
}
