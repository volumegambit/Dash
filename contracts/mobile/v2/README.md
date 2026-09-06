# `@dash/mobile-contract-v2`

Parallel version 2 mobile contract for resumable conversation runs and the durable input queue.
It re-exports the unchanged v1 public types from `@dash/mobile-contract` and adds the canonical
`MobileV2*` DTOs, OpenAPI document, WebSocket JSON Schema, and cross-platform fixtures.

Control frames are intentionally unsequenced. Every durable server transition has a nonnegative
`v2Seq`. On every sequenced model frame (`accepted`, `event`, `done`, and `error`), `id === runId`.
For input and queue transition frames, `id` is the originating command ID when one exists; recovery
and automatic terminalization transitions use a server-generated transition ID.
