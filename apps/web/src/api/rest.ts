import type {
  ConversationCreateRequest,
  ConversationMessagePage,
  ConversationPage,
  ConversationPatchRequest,
  ConversationSummary,
  GatewayIdentity,
  MobileAgent,
  MobileHealth,
  SubagentResumeResponse,
  WsTicketResponse,
} from '@dash/mobile-contract';

/** Supplies the bearer token used to authenticate mobile v1 REST calls. */
export interface TokenSource {
  getToken(): Promise<string>;
}

/** Thrown for any non-2xx mobile v1 REST response. */
export class MobileApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    /**
     * The gateway's own `error` string, when its structured
     * `{ code, error, retryable }` envelope carried one. `code` alone is a
     * machine label; `detail` is the sentence a human can act on — the
     * sub-agent resume route in particular answers its three refusals
     * (one-shot type, steer cap, unrebuildable grant) with text that names
     * which one happened, and a UI that showed only `validation_failed`
     * would be telling the user nothing.
     */
    readonly detail?: string,
  ) {
    super(code ? `Mobile API error ${status} (${code})` : `Mobile API error ${status}`);
    this.name = 'MobileApiError';
  }
}

interface RequestOptions {
  /** Defaults to true. `health()` is the only unauthenticated endpoint. */
  auth?: boolean;
  body?: unknown;
  query?: Record<string, string | undefined>;
  /** Optimistic-concurrency precondition (gateway `conversation-routes.ts`
   * `parseIfMatch`, mirrored from `ios/Dash/Core/Networking/GatewayAPI.swift`'s
   * `patchConversation`/`deleteConversation`): sent as `If-Match: "<revision>"`
   * — quoted, matching the gateway's own `ETag` format — so a stale local
   * revision surfaces as a `revision_conflict` (409) `MobileApiError` rather
   * than silently clobbering a concurrent edit. */
  ifMatch?: number;
}

/**
 * Joins `path` onto `baseUrl` without dropping or duplicating the base's own
 * path segments. `baseUrl` is expected to already include the full mobile v1
 * prefix (e.g. `https://sub.relay.example/mobile/v1`). Deliberately avoids
 * the two-argument `new URL(path, baseUrl)` form: because `path` always
 * starts with `/`, that form treats it as root-relative and silently
 * discards `baseUrl`'s own path (dropping `/mobile/v1`). Instead the full
 * absolute URL string is assembled first and only then parsed, so query
 * params can be appended safely.
 */
function buildUrl(baseUrl: string, path: string, query?: Record<string, string | undefined>): URL {
  const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${trimmedBase}${normalizedPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
  }
  return url;
}

async function readError(
  response: Response,
): Promise<{ code: string | undefined; detail: string | undefined }> {
  try {
    const data = (await response.json()) as { code?: unknown; error?: unknown };
    return {
      code: typeof data.code === 'string' ? data.code : undefined,
      detail: typeof data.error === 'string' ? data.error : undefined,
    };
  } catch {
    return { code: undefined, detail: undefined };
  }
}

/**
 * Thin `fetch` wrapper for the Dash mobile v1 REST surface. `baseUrl` must
 * include the full `/mobile/v1` prefix (e.g. `https://sub.relay.example/mobile/v1`).
 * No retries — retry policy lives in `state/` (see the retry-aware store built
 * on top of this client).
 */
export class MobileRestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: TokenSource,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    // ^ never store bare `fetch`: calling it as a method rebinds `this` and real
    //   browsers throw "Illegal invocation" (tests always inject, so only live use hit it)
    /** When set, sent as `x-dash-relay-credential` on every request
     * (including `health()`) so the relay can authenticate this browser's hop
     * to the gateway — separate from the `Authorization` bearer, which
     * authenticates to the gateway itself. The gateway/relay CORS allowlists
     * already permit this header. */
    private readonly relayCredential?: string,
  ) {}

  health(): Promise<MobileHealth> {
    return this.request<MobileHealth>('GET', '/health', { auth: false });
  }

  identity(): Promise<GatewayIdentity> {
    return this.request<GatewayIdentity>('GET', '/identity');
  }

  /** `MobileAgentList` (openapi.yaml `/agents` GET) is a bare array, not an
   * envelope — the response body IS the `MobileAgent[]`, no `items` wrapper
   * like the paginated conversation/message endpoints. */
  listAgents(): Promise<MobileAgent[]> {
    return this.request<MobileAgent[]>('GET', '/agents');
  }

  listConversations(cursor?: string): Promise<ConversationPage> {
    return this.request<ConversationPage>('GET', '/conversations', { query: { cursor } });
  }

  getMessages(conversationId: string, cursor?: string): Promise<ConversationMessagePage> {
    // The openapi `BeforeCursor` parameter for this endpoint is named `before`
    // on the wire; the public method param keeps the generic name `cursor`
    // per the brief's Interfaces block, so it's mapped here.
    return this.request<ConversationMessagePage>(
      'GET',
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      { query: { before: cursor } },
    );
  }

  createConversation(req: ConversationCreateRequest): Promise<ConversationSummary> {
    return this.request<ConversationSummary>('POST', '/conversations', { body: req });
  }

  /** `GET /conversations/:id` — a single conversation's current summary.
   * Mirrors iOS's `GatewayAPI.conversation(id:)`. Used by the store's
   * auto-title refresh (chat-ux Phase 3 Task 1, audit #8): after a turn
   * completes on a conversation whose local title is still the gateway's
   * default, this re-fetches that one row rather than the whole list, so an
   * unrelated concurrent edit elsewhere in `conversations` isn't clobbered. */
  getConversation(conversationId: string): Promise<ConversationSummary> {
    return this.request<ConversationSummary>(
      'GET',
      `/conversations/${encodeURIComponent(conversationId)}`,
    );
  }

  /** `PATCH /conversations/:id` — renames (or otherwise patches) a
   * conversation. Mirrors iOS's `GatewayAPI.patchConversation`
   * (`ConversationListFeature.swift:502`'s `retryRename`): `revision` is
   * sent as a quoted `If-Match` precondition, not in the body. */
  patchConversation(
    conversationId: string,
    patch: ConversationPatchRequest,
    revision: number,
  ): Promise<ConversationSummary> {
    return this.request<ConversationSummary>(
      'PATCH',
      `/conversations/${encodeURIComponent(conversationId)}`,
      { body: patch, ifMatch: revision },
    );
  }

  /** `DELETE /conversations/:id` — mirrors iOS's `GatewayAPI.deleteConversation`
   * (`ConversationListFeature.swift:536`'s `retryDelete`): no body, `revision`
   * sent as a quoted `If-Match` precondition. Resolves with the (now
   * tombstoned) summary, same as the gateway route returns. */
  deleteConversation(conversationId: string, revision: number): Promise<ConversationSummary> {
    return this.request<ConversationSummary>(
      'DELETE',
      `/conversations/${encodeURIComponent(conversationId)}`,
      { ifMatch: revision },
    );
  }

  /**
   * `POST /subagents/:id/resume` — sends a user turn INTO a child (design
   * §7.7, §8.3). Deliberately not a WS `message` frame addressed to the
   * child's conversation: only this route reaches
   * `coordinator.sendToChild` → `ChildHandle.send`, which is the one thing
   * that resolves a child blocked on `ask_orchestrator`, and the one place
   * the gateway enforces the one-shot refusal, the steer cap and the grant
   * rebuild ("one narrowing path, so an HTTP resume can never widen a child
   * past what the tool would have granted it" —
   * `apps/gateway/src/subagent-management.ts`). A `message` frame reaches
   * `hub.start` instead, which either rejects against the child's turn lease
   * or opens a second, parallel turn while the question stays blocked.
   *
   * All three coordinator refusals come back as 409 `validation_failed` with
   * the reason in `MobileApiError.detail`.
   */
  resumeSubagent(subagentId: string, message: string): Promise<SubagentResumeResponse> {
    return this.request<SubagentResumeResponse>(
      'POST',
      `/subagents/${encodeURIComponent(subagentId)}/resume`,
      { body: { message } },
    );
  }

  createWsTicket(): Promise<WsTicketResponse> {
    return this.request<WsTicketResponse>('POST', '/ws-ticket');
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const { auth = true, body, query, ifMatch } = options;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (ifMatch !== undefined) headers['If-Match'] = `"${ifMatch}"`;
    if (auth) {
      headers.Authorization = `Bearer ${await this.tokens.getToken()}`;
    }
    if (this.relayCredential) {
      headers['x-dash-relay-credential'] = this.relayCredential;
    }

    const response = await this.fetchImpl(buildUrl(this.baseUrl, path, query).toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const { code, detail } = await readError(response);
      throw new MobileApiError(response.status, code, detail);
    }

    return (await response.json()) as T;
  }
}
