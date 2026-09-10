export type MobileCapability = 'conversation-sync-v1' | 'chat-resume-v1' | 'speech-v1';
export type ConversationStatus = 'idle' | 'running' | 'interrupted' | 'archived' | 'deleted';
export type ConversationMessageStatus =
  | 'accepted'
  | 'streaming'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted';
export type ConversationRole = 'user' | 'assistant';
export type ConversationKind = 'user' | 'subagent';
export type ConversationMessageOrigin = 'user' | 'notification' | 'parent';
export type SubagentStatus =
  | 'running'
  | 'waiting_input'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'max_turns';
export type MobileImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface FixtureManifest {
  version: 1;
  cases: FixtureCase[];
}

export interface FixtureCase {
  file: string;
  document: 'openapi' | 'chat-ws';
  schema: string;
  valid: boolean;
  format?: 'json' | 'jsonl' | 'sse';
}

export interface MobileHealth {
  status: 'healthy';
  startedAt: string;
  pid: number;
  agents: number;
  channels: number;
  apiVersion: 1;
  capabilities: MobileCapability[];
}

export interface GatewayIdentity {
  gatewayId: string;
  publicKey: string;
}

export type PairingPayload =
  | {
      v: 2;
      host: string;
      secure: true;
      mgmtToken: string;
      chatToken: string;
      relayCredential: string;
    }
  | {
      v: 3;
      host: string;
      secure: true;
      mgmtToken: string;
      chatToken: string;
      mgmtPort: number;
      chatPort: number;
      tlsCertificateSha256: string;
    };

export interface MobileAgent {
  id: string;
  name: string;
  config: {
    name: string;
    model: string;
    systemPrompt: string;
    fallbackModels?: string[];
    tools?: string[];
    skills?: { paths?: string[]; urls?: string[] };
    workspace?: string;
    maxTokens?: number;
    mcpServers?: string[];
    plugins?: string[];
    providers?: string[];
    swarm?: {
      enabled?: boolean;
      maxConcurrentWorkers?: number;
      maxWorkersPerRun?: number;
      maxSteersPerWorker?: number;
      maxRunSeconds?: number;
      allowedModels?: string[];
    };
  };
  status: 'registered' | 'active' | 'disabled';
  registeredAt: string;
}

export interface CreateMobileAgentRequest {
  name: string;
  model: string;
  systemPrompt: string;
}

export interface UpdateMobileAgentRequest {
  model?: string;
  systemPrompt?: string;
}

export interface MobileActionResponse {
  ok: true;
}

/** Agent memory (`GET`/`DELETE` only on mobile; writes stay loopback-only). */
export type MobileMemoryType = 'user' | 'feedback' | 'project' | 'reference';

export type MobileMemorySource = 'agent' | 'sweep' | 'user' | 'import';

export interface MobileMemoryInfo {
  name: string;
  description: string;
  type: MobileMemoryType;
  source: MobileMemorySource;
  /** Bare `YYYY-MM-DD` day, not an RFC 3339 timestamp. */
  createdAt: string;
  /** Bare `YYYY-MM-DD` day, not an RFC 3339 timestamp. */
  updatedAt: string;
  size: number;
}

export interface MobileMemoryRecord extends Omit<MobileMemoryInfo, 'size'> {
  content: string;
}

export interface MobileMemoryDeleteResponse {
  name: string;
}

export interface MobileModel {
  value: string;
  label: string;
  provider: string;
}

export interface MobileModelsResponse {
  models: MobileModel[];
  source: 'live' | 'bootstrap';
  errors: Record<string, string>;
  fetchedAt: string;
  supportedModelsReviewedAt: string;
}

export interface MobileImage {
  mediaType: MobileImageMediaType;
  data: string;
}

export interface MobileAgentEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * What a notice is telling the user about. Clients pick an icon and a test id
 * from this; `text` is already display-ready.
 */
export type ConversationNoticeKind = 'skill_learned' | 'memory_saved';

export type ConversationContent =
  | { type: 'user'; text: string; images?: MobileImage[] }
  | { type: 'assistant'; events: MobileAgentEvent[] }
  /**
   * A short, persistent note the gateway appends to the conversation for
   * something that happened AFTER a turn was finalised — today, a skill learned
   * or a memory saved by the post-turn review.
   *
   * It is a message rather than an event because a finished turn cannot accept
   * further events (`appendTurnEvent` refuses once `activeTurnId` has cleared),
   * and because a live-only signal would vanish on reload. Carrying it as a
   * message means it replays with the rest of the conversation.
   */
  | { type: 'notice'; kind: ConversationNoticeKind; text: string };

/**
 * A skill as a mobile client sees it: read-only, and without the on-disk
 * `location` (a remote client has no use for a gateway filesystem path) or the
 * `editable` flag (nothing here is editable).
 */
export interface MobileSkill {
  name: string;
  description: string;
  trigger?: string;
  source: 'managed' | 'agent' | 'remote' | 'plugin';
  content?: string;
}

export interface SubagentUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Everything a client needs to render a sub-agent row without fetching the
 * child transcript. `depth` is 1 for a child of a user conversation.
 */
export interface SubagentInfo {
  type: string;
  name?: string;
  status: SubagentStatus;
  description: string;
  prompt: string;
  model: string;
  background: boolean;
  isolation?: 'worktree';
  depth: number;
  startedAt: string;
  endedAt?: string;
  usage?: SubagentUsage;
  toolCallCount: number;
  report?: string;
  oneShot: boolean;
  /**
   * The directory the child ACTUALLY ran in — its own checkout when
   * `isolation: 'worktree'` gave it one, the shared workspace otherwise.
   * Optional: it is only known once the child's backend has been built, so a
   * row read between `createSubagent` and the first turn has none.
   */
  workspace?: string;
}

/**
 * One child as `GET /conversations/:id/subagents` reports it (design §7.7) — a
 * trimmed {@link SubagentInfo} for the tasks panel. `prompt`, `model`,
 * `isolation` and `workspace` are deliberately absent: fetch the child
 * conversation for those.
 */
export interface SubagentListEntry {
  id: string;
  name?: string;
  type: string;
  description: string;
  status: SubagentStatus;
  background: boolean;
  depth: number;
  startedAt: string;
  endedAt?: string;
  usage?: SubagentUsage;
  toolCallCount: number;
  /** Scanned sub-agent output; absent until the child is terminal. */
  report?: string;
  /** Explore / Plan: `POST /subagents/:id/resume` 409s. */
  oneShot: boolean;
}

export interface SubagentListResponse {
  subagents: SubagentListEntry[];
}

export interface SubagentStopResponse {
  ok: true;
  status: 'done' | 'failed' | 'cancelled' | 'interrupted' | 'max_turns';
}

export interface SubagentResumeRequest {
  message: string;
  /**
   * Client-chosen correlation id, echoed verbatim on the `accepted` frame of
   * the turn this message becomes (see `MobileWsServerFrame`'s `accepted`
   * variant). The server picks the turn id for a resume, so without this the
   * client has no way to tell WHICH later `accepted` belongs to WHICH of its
   * own in-flight follow-ups, and a positional guess mis-pairs the moment one
   * `accepted` is missed.
   *
   * Optional on BOTH sides: an older client omits it, and an older gateway
   * accepts it and never echoes it. A client that sends one and gets an
   * `accepted` back without one must treat that turn as UNCORRELATED rather
   * than assuming it is its own.
   *
   * NOT the same thing as `ConversationCreateRequest`'s `requestId`, despite
   * the shared name: that one is an IDEMPOTENCY key the gateway persists and
   * de-duplicates conversation creation against, so re-sending it returns the
   * existing conversation. This one is never stored, is echoed once on a
   * single frame, and de-duplicates nothing — re-sending it starts a second
   * turn.
   */
  requestId?: string;
}

export interface SubagentResumeResponse {
  ok: boolean;
  status: SubagentStatus | 'spawning';
  /** `queued` — the child was running; `resumed` — a new turn was started on it. */
  mode: 'queued' | 'resumed';
}

export interface ConversationSummary {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  revision: number;
  status: ConversationStatus;
  activeTurnId: string | null;
  owningIssueId: string | null;
  projectId: string | null;
  lastSeq: number;
  lastMessagePreview: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  /** `'subagent'` rows are children; the conversation list shows `'user'` only. */
  kind: ConversationKind;
  parentConversationId?: string;
  parentTurnId?: string;
  subagent?: SubagentInfo;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  turnId: string;
  ordinal: number;
  role: ConversationRole;
  status: ConversationMessageStatus;
  content: ConversationContent;
  createdAt: string;
  updatedAt: string;
  /** Who caused this turn. Absent on pre-`origin` clients; treat as `'user'`. */
  origin?: ConversationMessageOrigin;
}

export interface ConversationPage {
  items: ConversationSummary[];
  nextCursor: string | null;
}

export interface ConversationMessagePage {
  items: ConversationMessage[];
  nextCursor: string | null;
  throughSeq: number;
}

export interface ConversationCreateRequest {
  agentId: string;
  requestId: string;
  title?: string;
  owningIssueId?: string;
  projectId?: string;
}

export interface ConversationPatchRequest {
  title?: string;
  owningIssueId?: string | null;
  projectId?: string | null;
}

export type MobileApiErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'validation_failed'
  | 'revision_conflict'
  | 'conversation_busy'
  | 'rate_limited'
  | 'gateway_offline'
  | 'capability_required'
  // `SpeechErrorCode` (`packages/speech/src/errors.ts`), reachable on `/speech/*`:
  // those handlers reuse this envelope and pass the provider-level code through
  // untranslated, so the union has to admit them.
  | 'too_large'
  | 'too_long'
  | 'provider'
  | 'network'
  | 'unavailable'
  | 'invalid';

export interface MobileApiError {
  code: MobileApiErrorCode;
  error: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

/**
 * A precise position. Present ONLY when the user opted in in-app AND the OS
 * granted a location permission.
 */
export interface MobilePreciseLocation {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  /** RFC 3339. May predate the message — clients may send a cached fix. */
  capturedAt: string;
  /** Reverse-geocoded place, when the client resolved one. Best-effort. */
  place?: string;
}

/**
 * Location context a client reports with a chat turn.
 *
 * The coarse fields need no OS permission on any platform: they come from
 * `Intl`/`Locale`, which every locale-aware UI already reads.
 */
export interface MobileClientLocation {
  /** IANA time zone id, e.g. "Asia/Singapore". */
  timezone: string;
  /**
   * Minutes EAST of UTC at send time (Singapore = 480). Disambiguates DST.
   * NOTE the sign: JS `Date.getTimezoneOffset()` is west-positive and MUST be
   * negated by web/Electron clients; Swift's `TimeZone.secondsFromGMT()` is
   * already east-positive and only needs dividing by 60.
   */
  utcOffsetMinutes: number;
  /** BCP-47 language tag, e.g. "en-SG". */
  locale: string;
  /** ISO 3166-1 alpha-2 region when the platform exposes one. */
  region?: string;
  precise?: MobilePreciseLocation;
}

export type MobileWsClientFrame =
  | {
      type: 'message';
      id: string;
      agentId: string;
      channelId: string;
      conversationId: string;
      text: string;
      location?: MobileClientLocation;
      images?: MobileImage[];
      streamingBehavior?: 'steer' | 'followUp';
      resumable?: boolean;
    }
  | { type: 'resume'; id: string; agentId: string; conversationId: string; sinceSeq: number }
  | { type: 'answer'; id: string; questionId: string; answer: string }
  | { type: 'cancel'; id: string }
  /**
   * Watch a conversation the socket did not start a turn on, so server-initiated
   * turns (`accepted` with `origin: 'notification'`) and sub-agent child turns
   * reach it. `message` and `resume` subscribe implicitly; this frame is only
   * needed for a conversation the socket has not otherwise touched.
   */
  | { type: 'subscribe'; id: string; agentId: string; conversationId: string }
  | { type: 'unsubscribe'; id: string; agentId: string; conversationId: string };

export type MobileWsServerFrame =
  | {
      type: 'accepted';
      id: string;
      conversationId: string;
      userMessageId: string;
      assistantMessageId: string;
      revision: number;
      seq: number;
      /**
       * Who caused this turn. On a LIVE frame it is omitted for an ordinary
       * user turn on a user conversation — so a pre-subscription client sees
       * the same bytes it always did — and absent therefore means `'user'`.
       *
       * On the REPLAY path (`/conversations/:id/replay`, and any `accepted`
       * rebuilt from the event log) it is never emitted at all, because the
       * durable payload does not carry it yet: absent there means UNKNOWN, not
       * `'user'`. Read `ConversationMessage.origin` for a replayed turn.
       */
      origin?: ConversationMessageOrigin;
      /**
       * Conversation kind, omitted alongside `origin` and under the same
       * live-versus-replay rule. For a replayed turn read
       * `ConversationSummary.kind`.
       */
      kind?: ConversationKind;
      /**
       * Echo of `SubagentResumeRequest.requestId` for the turn that request
       * became — the client's only way to pair one of its own in-flight
       * follow-ups with the `accepted` it produced.
       *
       * LIVE-ONLY, and unlike `origin`/`kind` it is deliberately NOT declared
       * on `ReplayPayload`: the durable event log stores server state, and a
       * client's correlation id is not that. It is also emitted only by a
       * message that STARTS a turn — an answer to a parked `ask_orchestrator`
       * question resolves inside the running turn, so no `accepted` carries
       * its id, ever.
       */
      requestId?: string;
    }
  | {
      type: 'event';
      id: string;
      conversationId?: string;
      seq?: number;
      event: MobileAgentEvent;
    }
  | {
      type: 'done';
      id: string;
      conversationId?: string;
      seq?: number;
      outcome?: 'completed' | 'cancelled';
    }
  | {
      type: 'error';
      id: string;
      conversationId?: string;
      seq?: number;
      error: string;
      code?: MobileApiErrorCode;
      retryable?: boolean;
      activeTurnId?: string;
    };

export type ReplayPayload =
  | {
      type: 'accepted';
      userMessageId: string;
      assistantMessageId: string;
      revision: number;
    }
  | { type: 'event'; event: MobileAgentEvent }
  | { type: 'done'; outcome?: 'completed' | 'cancelled' }
  | { type: 'error'; error: string; code?: MobileApiErrorCode; retryable?: boolean };

export interface ReplayEntry {
  seq: number;
  msgId: string;
  agentId: string;
  conversationId: string;
  timestamp: string;
  payload: ReplayPayload;
}

export interface ReplayPage {
  entries: ReplayEntry[];
}

export interface ConversationChangedEvent {
  type: 'conversation:changed';
  conversationId: string;
  revision: number;
}

export interface ConversationDeletedEvent {
  type: 'conversation:deleted';
  conversationId: string;
  revision: number;
}

/** Response of POST /mobile/v1/ws-ticket — single-use WebSocket upgrade ticket. */
export interface WsTicketResponse {
  ticket: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Speech (`/speech/*`). Mirrors `@dash/speech`'s own types, restated here so a
// client depends on the frozen wire contract rather than on the server package.
// ---------------------------------------------------------------------------

export type SpeechModelKind = 'transcription' | 'speech';

export type SpeechAudioFormat = 'wav' | 'm4a' | 'mp3' | 'flac' | 'ogg' | 'webm' | 'aac';

export type SpeechProviderReason = 'no_credential' | 'no_provider_offers_realtime';

export interface SpeechSttConfig {
  provider: string;
  model: string;
  language?: string;
}

export interface SpeechTtsConfig {
  provider: string;
  model: string;
  voice: string;
  speed?: number;
}

/** `null` means "no realtime provider" and is a real value, never an omission. */
export interface SpeechRealtimeConfig {
  provider: string | null;
}

export interface SpeechConfigDTO {
  stt: SpeechSttConfig;
  tts: SpeechTtsConfig;
  realtime: SpeechRealtimeConfig;
}

export interface SpeechCapabilitiesDTO {
  transcription: boolean;
  speech: boolean;
  realtime: boolean;
}

/** `reason` is present only when `available` is false. */
export interface SpeechProviderStatusDTO {
  id: string;
  capabilities: SpeechCapabilitiesDTO;
  available: boolean;
  reason?: SpeechProviderReason;
}

/** The body of both `GET` and `PATCH /speech/config`. */
export interface SpeechConfigResponse {
  config: SpeechConfigDTO;
  providers: SpeechProviderStatusDTO[];
}

/**
 * A shallow per-section merge. NOTE the asymmetry on `realtime`: the section
 * itself is optional, but once present its `provider` key is REQUIRED (and may
 * be null) — the gateway 400s on `{ "realtime": {} }`. That is why it is typed
 * as the whole `SpeechRealtimeConfig` rather than a `Partial` of it.
 */
export interface SpeechConfigPatch {
  /**
   * `language: null` CLEARS the language (back to the provider's own
   * detection); omitting the key leaves it alone. Spelled out rather than
   * `Partial<SpeechSttConfig>`, which cannot express the difference.
   */
  stt?: { provider?: string; model?: string; language?: string | null };
  tts?: Partial<SpeechTtsConfig>;
  realtime?: SpeechRealtimeConfig;
}

export interface SpeechModelDTO {
  id: string;
  name: string;
  kind: SpeechModelKind;
  voices?: string[];
}

export interface SpeechModelList {
  models: SpeechModelDTO[];
}

export interface TranscriptionRequest {
  /** Standard base64. Decoded size is capped at 8 MiB; the clip at 60 seconds. */
  audio: string;
  format: SpeechAudioFormat;
  language?: string;
}

export interface TranscriptionResponse {
  text: string;
  durationSeconds?: number;
}

/** `POST /speech/speech`. The RESPONSE is `audio/mpeg` bytes, not JSON. */
export interface SynthesisRequest {
  /** At most 4 000 characters; over that the gateway answers 413 `too_long`. */
  text: string;
}
