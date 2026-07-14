# Dash mobile contract v1

This package freezes the JSON-safe TypeScript types, OpenAPI 3.1 document, WebSocket JSON
Schema, and canonical wire fixtures used by the Dash gateway and native mobile clients. It has
no runtime behavior; `src/index.ts` exports types only.

## Contract documents

- `openapi.yaml` describes the authenticated management, conversation, replay, and SSE APIs.
  The frozen REST surface is rooted at `/mobile/v1`; only `GET /mobile/v1/health` is
  unauthenticated. The gateway retains unprefixed aliases for compatibility, but native clients
  use the versioned namespace.
- `chat-ws.schema.json` describes capable v1 fixture frames and compatibility unions for the
  existing chat WebSocket wire protocol.
- `src/types.ts` is the shared compile-time view of the same JSON wire values.
- `fixtures/manifest.json` is the exhaustive source of fixture paths, target schemas, and
  expected validation polarity.

The manifest has this shape:

```ts
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
```

`format` is present only when a fixture is JSON Lines or an SSE wire record. Ordinary JSON
fixtures omit it.

## Canonical fixtures

The root fixtures are:

- Pairing and gateway: current secure payloads are `pairing-lan-v3.json` and
  `pairing-relay-v2.json`; `pairing-lan-v1.json` is retained as a negative migration fixture so
  clients keep rejecting legacy plaintext pairing. Gateway fixtures are `health-capabilities.json`
  and `identity.json`.
- Agents and models: `agents-list.json`, `agent-create.json`, `agent-update.json`,
  `agent-action-ok.json`, and `models-list.json`.
- Conversations and replay: `conversation-create.json`, `conversation-patch.json`,
  `conversation-summary.json`, `conversations-page.json`, `conversation-messages-page.json`,
  and `replay.json`.
- Chat frames: `chat-send.json`, `chat-resume.json`, `chat-answer.json`, `chat-cancel.json`,
  `chat-accepted.json`, `chat-event.json`, `chat-done.json`, and `chat-error.json`.
- Streams: `chat-stream.jsonl`, `chat-resume.jsonl`, `sse-conversation-changed.txt`, and
  `sse-conversation-deleted.txt`.

Structured error fixtures live under `fixtures/errors/`:

- `unauthorized.json`, `not-found.json`, `validation-failed.json`,
  `revision-conflict.json`, `conversation-busy.json`, `rate-limited.json`,
  `gateway-offline.json`, and `capability-required.json`.
- `unsupported-pairing-version.json` and `missing-relay-credential.json` are intentionally
  invalid pairing payloads.

Negative conformance fixtures live under `fixtures/invalid/`:

- Pairing and gateway: `pairing-host-with-scheme.json`, `pairing-port-out-of-range.json`,
  `pairing-blank-secret.json`, the v2/v3 mismatched-mobile-token fixtures,
  `pairing-v3-mismatched-ports.json`, `health-missing-api-version.json`, and
  `identity-missing-gateway-id.json`.
- Agents and models: `agents-list-secret-leak.json`, `agent-action-not-ok.json`, and
  `models-list-missing-provider.json`.
- Conversations and replay: `conversation-create-missing-request-id.json`,
  `conversation-patch-empty.json`, `conversation-summary-bad-status.json`,
  `conversations-page-missing-items.json`, `conversation-messages-page-bad-content.json`, and
  `replay-out-of-order.json`.
- Chat: `chat-send-missing-turn-id.json`, `chat-resume-negative-seq.json`,
  `chat-answer-missing-question-id.json`, `chat-cancel-missing-id.json`,
  `chat-accepted-missing-seq.json`, `chat-event-missing-conversation-id.json`,
  `chat-done-missing-outcome.json`, and `chat-error-missing-error.json`.
- Errors: `structured-error-missing-code.json`.

## Compatibility rules

- Nullable wire fields use explicit JSON `null`; omission and `null` are not interchangeable.
  Conversation summaries always include their nullable relationship, active-turn, preview, and
  cursor fields. Optional fields such as `deletedAt` may be omitted.
- Page cursors are opaque strings. Clients must persist or return them unchanged and must not
  derive ordering information from their contents.
- Agent IDs and channel IDs are opaque non-empty strings. Conversation, turn, and message IDs
  use UUID wire values.
- Unknown agent event variants remain valid. Clients must preserve or ignore unfamiliar event
  properties without rejecting the containing frame.
- Fixed DTOs reject unknown fields. Pairing payloads deliberately allow unknown non-secret
  metadata so future pairing producers remain forward compatible.
- Both secure pairing modes carry one phone-scoped capability in the frozen `mgmtToken` and
  `chatToken` fields. Clients trim both values before comparing them and store the single
  normalized capability. Direct LAN v3 also uses one pinned-TLS listener, so `mgmtPort` and
  `chatPort` must be equal. Contract checks enforce both semantic invariants in addition to JSON
  Schema.
- Pairing producers emit lowercase SHA-256 certificate fingerprints. Native clients may accept
  uppercase input but normalize the stored pin to lowercase before connecting.
- Mutating a tombstoned conversation with `PATCH`, or repeating its `DELETE`, returns HTTP 410
  with a non-retryable `not_found` error. `GET` still returns the revisioned tombstone.
- Any change to a TypeScript wire type or schema requires coordinated updates to the other
  contract document, every affected positive and negative fixture, and `manifest.json` in the
  same change.

Run `npm run mobile:contract-check` from the repository root to validate every manifest case and
verify that no fixture is duplicated or unlisted.
