import type {
  ConversationCreateRequest,
  ConversationMessagePage,
  ConversationPage,
  ConversationPatchRequest,
  ConversationSummary,
  GatewayIdentity,
  MobileAgent,
  MobileApiError as MobileApiErrorBody,
  MobileApiErrorCode,
  MobileHealth,
  WsTicketResponse,
} from '@dash/mobile-contract';
import type {
  MobileV2ConversationBootstrap,
  MobileV2ConversationMessagePage,
  MobileV2HealthResponse,
} from '@dash/mobile-contract-v2';

/** Supplies the bearer token used to authenticate mobile REST calls. */
export interface TokenSource {
  getToken(): Promise<string>;
}

/** Thrown for any non-2xx mobile REST response. */
export class MobileApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: MobileApiErrorCode | undefined,
    readonly apiError?: MobileApiErrorBody,
  ) {
    super(code ? `Mobile API error ${status} (${code})` : `Mobile API error ${status}`);
    this.name = 'MobileApiError';
  }
}

interface RequestOptions {
  /** Defaults to true. Both versioned `health` endpoints are unauthenticated. */
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

const MOBILE_API_ERROR_CODES: Record<MobileApiErrorCode, true> = {
  unauthorized: true,
  not_found: true,
  validation_failed: true,
  revision_conflict: true,
  conversation_busy: true,
  rate_limited: true,
  gateway_offline: true,
  capability_required: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isMobileApiErrorBody(value: unknown): value is MobileApiErrorBody {
  if (!isRecord(value)) return false;
  const expectedKeys = Object.hasOwn(value, 'details')
    ? ['code', 'error', 'retryable', 'details']
    : ['code', 'error', 'retryable'];
  return (
    hasExactKeys(value, expectedKeys) &&
    typeof value.code === 'string' &&
    Object.hasOwn(MOBILE_API_ERROR_CODES, value.code) &&
    typeof value.error === 'string' &&
    value.error.trim().length > 0 &&
    typeof value.retryable === 'boolean' &&
    (!Object.hasOwn(value, 'details') || isRecord(value.details))
  );
}

function isGatewayIdentity(value: unknown): value is GatewayIdentity {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['gatewayId', 'publicKey']) &&
    typeof value.gatewayId === 'string' &&
    value.gatewayId.length > 0 &&
    typeof value.publicKey === 'string' &&
    value.publicKey.length > 0
  );
}

async function readMobileApiError(response: Response): Promise<MobileApiErrorBody | undefined> {
  try {
    const data: unknown = await response.json();
    return isMobileApiErrorBody(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Thin `fetch` wrapper for one Dash mobile REST surface. `baseUrl` must
 * include the full version prefix (for example `https://sub.relay.example/mobile/v2`).
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

  healthV2(): Promise<MobileV2HealthResponse> {
    return this.request<MobileV2HealthResponse>('GET', '/health', { auth: false });
  }

  async identity(): Promise<GatewayIdentity> {
    let value: unknown;
    try {
      value = await this.request<unknown>('GET', '/identity');
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Malformed gateway identity', { cause: error });
      }
      throw error;
    }
    if (!isGatewayIdentity(value)) {
      throw new Error('Malformed gateway identity');
    }
    return value;
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

  bootstrap(conversationId: string): Promise<MobileV2ConversationBootstrap> {
    return this.request<MobileV2ConversationBootstrap>(
      'GET',
      `/conversations/${encodeURIComponent(conversationId)}/bootstrap`,
    );
  }

  getMessagesV2(
    conversationId: string,
    before?: string,
    limit?: number,
  ): Promise<MobileV2ConversationMessagePage> {
    return this.request<MobileV2ConversationMessagePage>(
      'GET',
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      { query: { limit: limit === undefined ? undefined : String(limit), before } },
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
      const apiError = await readMobileApiError(response);
      throw new MobileApiError(response.status, apiError?.code, apiError);
    }

    return (await response.json()) as T;
  }
}
