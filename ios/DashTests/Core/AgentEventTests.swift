import Foundation
import Testing

@testable import Dash

/// Wire-level cover for the three canonical sub-agent events (sub-agents
/// design §7.2) and for the legacy `worker_*` mirrors they replace in D8.
///
/// `ContractFixtureTests` next door proves the FIXTURE decodes as known cases
/// and re-encodes byte-for-byte. This suite covers the cases a positive
/// fixture cannot: required fields that must be rejected when absent, statuses
/// the producer can emit that the fixture does not exercise, and the optional
/// fields that must survive a round trip only when they were present.
@Suite("Sub-agent agent events")
struct AgentEventTests {
  private func decode(_ json: String) throws -> AgentEvent {
    try ContractCoding.decoder().decode(AgentEvent.self, from: Data(json.utf8))
  }

  private func canonical(_ data: Data) throws -> Data {
    try JSONSerialization.data(
      withJSONObject: try JSONSerialization.jsonObject(with: data),
      options: [.sortedKeys]
    )
  }

  private func roundTrip(_ json: String) throws {
    let event = try decode(json)
    if case let .unknown(type, _) = event {
      Issue.record("decoded as unknown: \(type)")
      return
    }
    let encoded = try canonical(ContractCoding.encoder().encode(event))
    #expect(encoded == (try canonical(Data(json.utf8))), "round-trip failed for \(json)")
  }

  @Test("subagent_started keeps every optional it was given")
  func startedFullShape() throws {
    let json = """
      {"type":"subagent_started","subagentId":"sub-1","name":"reviewer",\
      "subagentType":"code-reviewer","description":"Review the diff",\
      "prompt":"Review the diff and report","model":"anthropic/claude-opus-4",\
      "background":true,"depth":2,"startedAt":"2026-09-04T00:00:00.000Z",\
      "isolation":"worktree","parentTurnId":"turn-9"}
      """
    try roundTrip(json)

    guard
      case let .subagentStarted(
        subagentID, name, type, description, prompt, model, background, depth, startedAt,
        isolation, parentTurnID) = try decode(json)
    else {
      Issue.record("expected subagent_started")
      return
    }
    #expect(subagentID == "sub-1")
    #expect(name == "reviewer")
    #expect(type == "code-reviewer")
    #expect(description == "Review the diff")
    #expect(prompt == "Review the diff and report")
    #expect(model == "anthropic/claude-opus-4")
    #expect(background == true)
    #expect(depth == 2)
    #expect(startedAt == Date(timeIntervalSince1970: 1_788_480_000))
    #expect(isolation == "worktree")
    #expect(parentTurnID == "turn-9")
  }

  @Test("subagent_started omits the optionals it was not given")
  func startedMinimalShape() throws {
    // `name`, `isolation` and `parentTurnId` are optional on the wire
    // (§7.2 plus `packages/agent/src/types.ts`). Re-encoding them as explicit
    // nulls would change the bytes an old gateway sees, so the round trip is
    // the assertion.
    try roundTrip(
      """
      {"type":"subagent_started","subagentId":"sub-1","subagentType":"Explore",\
      "description":"map code","prompt":"map it","model":"m","background":false,\
      "depth":1,"startedAt":"2026-09-04T00:00:00.000Z"}
      """
    )
  }

  @Test("subagent_started without a subagentId is rejected, not silently empty")
  func startedRequiresSubagentID() {
    #expect(throws: (any Error).self) {
      _ = try decode(
        """
        {"type":"subagent_started","subagentType":"Explore","description":"d",\
        "prompt":"p","model":"m","background":false,"depth":1,\
        "startedAt":"2026-09-04T00:00:00.000Z"}
        """
      )
    }
  }

  @Test("subagent_progress carries its question and round-trips")
  func progressWaiting() throws {
    let json = """
      {"type":"subagent_progress","subagentId":"sub-1","status":"waiting_input",\
      "toolCallCount":3,"elapsedMs":7200,"detail":"reading files","question":"Which branch?"}
      """
    try roundTrip(json)

    guard
      case let .subagentProgress(subagentID, status, toolCallCount, elapsedMs, detail, question) =
        try decode(json)
    else {
      Issue.record("expected subagent_progress")
      return
    }
    #expect(subagentID == "sub-1")
    #expect(status == .waitingInput)
    #expect(toolCallCount == 3)
    #expect(elapsedMs == 7200)
    #expect(detail == "reading files")
    #expect(question == "Which branch?")
  }

  @Test("an unknown progress status is rejected rather than coerced to running")
  func progressRejectsUnknownStatus() {
    #expect(throws: (any Error).self) {
      _ = try decode(
        """
        {"type":"subagent_progress","subagentId":"sub-1","status":"napping",\
        "toolCallCount":0,"elapsedMs":0}
        """
      )
    }
  }

  @Test("every subagent_finished terminal status decodes", arguments: [
    ("done", SubagentTerminalStatus.done),
    ("failed", SubagentTerminalStatus.failed),
    ("cancelled", SubagentTerminalStatus.cancelled),
    ("interrupted", SubagentTerminalStatus.interrupted),
    ("max_turns", SubagentTerminalStatus.maxTurns),
  ])
  func finishedStatuses(raw: String, expected: SubagentTerminalStatus) throws {
    let json = """
      {"type":"subagent_finished","subagentId":"sub-1","subagentType":"code-reviewer",\
      "description":"Review the diff","status":"\(raw)","report":"done","toolCallCount":5,\
      "startedAt":"2026-09-04T00:00:00.000Z","endedAt":"2026-09-04T00:01:12.000Z"}
      """
    try roundTrip(json)
    guard case let .subagentFinished(_, _, _, _, status, _, _, _, _, _) = try decode(json) else {
      Issue.record("expected subagent_finished")
      return
    }
    #expect(status == expected)
  }

  /// `packages/agent/src/types.ts:81` gives `worker_done.status` all FIVE
  /// terminal values, but iOS only ever modelled three — so a real
  /// `interrupted` or `max_turns` mirror threw a decoding error and took its
  /// whole frame down. One enum now serves both families.
  @Test("worker_done accepts interrupted and max_turns", arguments: ["interrupted", "max_turns"])
  func legacyDoneAcceptsWiderStatuses(raw: String) throws {
    let json = """
      {"type":"worker_done","workerId":"w1","runId":"r1","role":"reviewer",\
      "status":"\(raw)","report":"stopped"}
      """
    try roundTrip(json)
    guard case let .workerDone(_, _, _, status, _, _) = try decode(json) else {
      Issue.record("expected worker_done")
      return
    }
    #expect(status.rawValue == raw)
  }

  @Test("subagent_finished usage survives the round trip")
  func finishedUsage() throws {
    let json = """
      {"type":"subagent_finished","subagentId":"sub-1","name":"reviewer",\
      "subagentType":"code-reviewer","description":"Review the diff","status":"done",\
      "report":"Two findings.","usage":{"inputTokens":1200,"outputTokens":340},\
      "toolCallCount":5,"startedAt":"2026-09-04T00:00:00.000Z",\
      "endedAt":"2026-09-04T00:01:12.000Z"}
      """
    try roundTrip(json)
    guard case let .subagentFinished(_, _, _, _, _, report, usage, count, _, endedAt) =
      try decode(json)
    else {
      Issue.record("expected subagent_finished")
      return
    }
    #expect(report == "Two findings.")
    #expect(usage == UsageDTO(inputTokens: 1200, outputTokens: 340, cacheReadTokens: nil, cacheWriteTokens: nil))
    #expect(count == 5)
    #expect(endedAt == Date(timeIntervalSince1970: 1_788_480_072))
  }

  @Test("subagent_finished without endedAt is rejected")
  func finishedRequiresEndedAt() {
    #expect(throws: (any Error).self) {
      _ = try decode(
        """
        {"type":"subagent_finished","subagentId":"sub-1","subagentType":"t",\
        "description":"d","status":"done","report":"r","toolCallCount":1,\
        "startedAt":"2026-09-04T00:00:00.000Z"}
        """
      )
    }
  }
}
