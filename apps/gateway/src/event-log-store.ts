import type { AgentEvent } from '@dash/agent';

/**
 * Durable per-conversation event log used to recover events that MC
 * missed when a chat WebSocket drops mid-stream.
 *
 * Each entry carries a `seq` — a per-conversation monotonic counter.
 * MC uses seq as a resume cursor: `readSince(sinceSeq)` returns every
 * entry with `seq > sinceSeq`. A terminal payload (`{type: 'done'}`
 * or `{type: 'error'}`) marks stream completion, so consumers can
 * distinguish "stream ended cleanly" from "log cuts off because the
 * gateway died mid-turn".
 *
 * This file is intentionally implementation-free: it declares the
 * interface + row shape only. The concrete storage adapter lives in
 * `event-log-store-sqlite.ts` (or a sibling if we ever need another
 * backend). Callers inside the gateway depend on `EventLogStore` —
 * never on a specific backend — so the rest of the codebase stays
 * free of SQL or any storage-specific assumptions. The composition
 * root in `index.ts` picks the concrete class.
 */
export interface EventLogEntry {
  seq: number;
  msgId: string;
  agentId: string;
  conversationId: string;
  timestamp: string;
  payload: EventLogPayload;
}

/**
 * Discriminated union for the event log payload. `event` wraps a
 * streaming `AgentEvent`; `done` / `error` are synthetic terminal
 * markers appended when the stream ends.
 */
export type EventLogPayload =
  | { type: 'event'; event: AgentEvent }
  | { type: 'done' }
  | { type: 'error'; error: string };

export interface EventLogStore {
  /**
   * Append a logged event. Returns the assigned per-conversation
   * monotonic `seq`. Concurrent callers must see a strictly
   * increasing sequence — the adapter is responsible for that
   * invariant (whether via single-thread JS semantics, SQL
   * transactions, or any future equivalent).
   */
  append(agentId: string, conversationId: string, msgId: string, payload: EventLogPayload): number;

  /**
   * Return every entry with `seq > sinceSeq` for this conversation
   * in seq order. Empty array if the log has no newer entries.
   * Callers pass `sinceSeq = 0` to read from the beginning.
   */
  readSince(agentId: string, conversationId: string, sinceSeq: number): EventLogEntry[];

  /**
   * Delete every entry for an agent. Called from `DELETE /agents/:id`
   * so the log doesn't outlive the agent it documents.
   */
  deleteAgent(agentId: string): void;

  /**
   * Delete a single conversation's entries. Exposed for tests and
   * future "clear conversation" operations; no production caller
   * today.
   */
  deleteConversation(agentId: string, conversationId: string): void;

  /**
   * Release resources. Call during graceful gateway shutdown so any
   * buffered writes are flushed and file handles are released
   * cleanly. Tests use this via `afterEach`.
   */
  close(): void;
}
