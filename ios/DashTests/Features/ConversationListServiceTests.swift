import Foundation
import Testing

@testable import Dash

@Suite("Live conversation list service", .serialized)
struct ConversationListServiceTests {
  private let gatewayID = "gateway-service-tests"

  init() {
    URLProtocolStub.reset()
  }

  @Test("PATCH 410 resolves and persists the canonical tombstone")
  func renameTombstoneRecovery() async throws {
    let tombstone = summary(title: "Already deleted", revision: 3, status: .deleted)
    try URLProtocolStub.enqueue(status: 410, fixture: "errors/not-found.json")
    URLProtocolStub.enqueue(status: 200, data: try encode(tombstone))
    let store = try PersistenceStore.inMemory()
    let service = makeService(store: store)

    let result = try await service.rename(
      id: tombstone.id,
      title: "Too late",
      revision: 2
    )

    #expect(result == tombstone)
    #expect(
      try await store.conversation(gatewayID: gatewayID, id: tombstone.id)?.summary == tombstone)
    #expect(URLProtocolStub.requests.map(\.httpMethod) == ["PATCH", "GET"])
  }

  @Test("DELETE 410 resolves and persists the canonical tombstone")
  func deleteTombstoneRecovery() async throws {
    let tombstone = summary(revision: 3, status: .deleted)
    try URLProtocolStub.enqueue(status: 410, fixture: "errors/not-found.json")
    URLProtocolStub.enqueue(status: 200, data: try encode(tombstone))
    let store = try PersistenceStore.inMemory()
    let service = makeService(store: store)

    let result = try await service.delete(id: tombstone.id, revision: 2)

    #expect(result == tombstone)
    #expect(
      try await store.conversation(gatewayID: gatewayID, id: tombstone.id)?.summary == tombstone)
    #expect(URLProtocolStub.requests.map(\.httpMethod) == ["DELETE", "GET"])
  }

  @Test("a mutation and point read 404 remain a true not-found")
  func trueNotFoundRecovery() async throws {
    try URLProtocolStub.enqueue(status: 404, fixture: "errors/not-found.json")
    try URLProtocolStub.enqueue(status: 404, fixture: "errors/not-found.json")
    let service = makeService(store: try PersistenceStore.inMemory())

    let error = await gatewayError {
      try await service.rename(id: "missing", title: "Missing", revision: 2)
    }

    #expect(error == .notFound)
    #expect(URLProtocolStub.requests.map(\.httpMethod) == ["PATCH", "GET"])
  }

  @Test("an ambiguous PATCH that landed returns the point-read canonical value")
  func landedRenameRecovery() async throws {
    let renamed = summary(title: "Renamed", revision: 3)
    URLProtocolStub.enqueue(failure: URLError(.timedOut))
    URLProtocolStub.enqueue(status: 200, data: try encode(renamed))
    let store = try PersistenceStore.inMemory()
    let service = makeService(store: store)

    let result = try await service.rename(id: renamed.id, title: renamed.title, revision: 2)

    #expect(result == renamed)
    #expect(try await store.conversation(gatewayID: gatewayID, id: renamed.id)?.summary == renamed)
    #expect(URLProtocolStub.requests.map(\.httpMethod) == ["PATCH", "GET"])
  }

  @Test("an ambiguous PATCH that did not land retries the same base revision")
  func unlandedRenameRecovery() async throws {
    let base = summary(title: "Original", revision: 2)
    let renamed = summary(title: "Renamed", revision: 3)
    URLProtocolStub.enqueue(failure: URLError(.timedOut))
    URLProtocolStub.enqueue(status: 200, data: try encode(base))
    URLProtocolStub.enqueue(status: 200, data: try encode(renamed))
    let service = makeService(store: try PersistenceStore.inMemory())

    let result = try await service.rename(
      id: base.id, title: renamed.title, revision: base.revision)

    #expect(result == renamed)
    #expect(URLProtocolStub.requests.map(\.httpMethod) == ["PATCH", "GET", "PATCH"])
    #expect(URLProtocolStub.requests.last?.value(forHTTPHeaderField: "If-Match") == "\"2\"")
  }

  @Test("an ambiguous PATCH retry timeout resolves the canonical rename")
  func ambiguousRenameRetryRecovery() async throws {
    let base = summary(title: "Original", revision: 2)
    let renamed = summary(title: "Renamed", revision: 3)
    URLProtocolStub.enqueue(failure: URLError(.timedOut))
    URLProtocolStub.enqueue(status: 200, data: try encode(base))
    URLProtocolStub.enqueue(failure: URLError(.timedOut))
    URLProtocolStub.enqueue(status: 200, data: try encode(renamed))
    let service = makeService(store: try PersistenceStore.inMemory())

    let result = try await service.rename(
      id: base.id,
      title: renamed.title,
      revision: base.revision
    )

    #expect(result == renamed)
    #expect(URLProtocolStub.requests.map(\.httpMethod) == ["PATCH", "GET", "PATCH", "GET"])
  }

  @Test("a PATCH retry 410 resolves the canonical tombstone")
  func renameRetryTombstoneRecovery() async throws {
    let base = summary(title: "Original", revision: 2)
    let tombstone = summary(title: "Original", revision: 3, status: .deleted)
    URLProtocolStub.enqueue(failure: URLError(.timedOut))
    URLProtocolStub.enqueue(status: 200, data: try encode(base))
    try URLProtocolStub.enqueue(status: 410, fixture: "errors/not-found.json")
    URLProtocolStub.enqueue(status: 200, data: try encode(tombstone))
    let service = makeService(store: try PersistenceStore.inMemory())

    let result = try await service.rename(
      id: base.id,
      title: "Renamed",
      revision: base.revision
    )

    #expect(result == tombstone)
    #expect(URLProtocolStub.requests.map(\.httpMethod) == ["PATCH", "GET", "PATCH", "GET"])
  }

  @Test("a PATCH retry not-found with an active point read requires an update")
  func renameRetryNotFoundActiveRecovery() async throws {
    let base = summary(title: "Original", revision: 2)
    URLProtocolStub.enqueue(failure: URLError(.timedOut))
    URLProtocolStub.enqueue(status: 200, data: try encode(base))
    try URLProtocolStub.enqueue(status: 410, fixture: "errors/not-found.json")
    URLProtocolStub.enqueue(status: 200, data: try encode(base))
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations([base], gatewayID: gatewayID)
    let service = makeService(store: store)

    let error = await gatewayError {
      try await service.rename(
        id: base.id,
        title: "Renamed",
        revision: base.revision
      )
    }

    #expect(error == .updateRequired)
    #expect(URLProtocolStub.requests.map(\.httpMethod) == ["PATCH", "GET", "PATCH", "GET"])
    #expect(try await store.conversation(gatewayID: gatewayID, id: base.id)?.summary == base)
  }

  @Test("a still-unresolved PATCH retry reports an unknown outcome")
  func unresolvedRenameRetry() async throws {
    let base = summary(title: "Original", revision: 2)
    URLProtocolStub.enqueue(failure: URLError(.timedOut))
    URLProtocolStub.enqueue(status: 200, data: try encode(base))
    URLProtocolStub.enqueue(failure: URLError(.timedOut))
    URLProtocolStub.enqueue(status: 200, data: try encode(base))
    let service = makeService(store: try PersistenceStore.inMemory())

    let error = await gatewayError {
      try await service.rename(id: base.id, title: "Renamed", revision: base.revision)
    }

    #expect(error == .mutationOutcomeUnknown(resourceID: base.id, requestID: nil))
    #expect(URLProtocolStub.requests.map(\.httpMethod) == ["PATCH", "GET", "PATCH", "GET"])
  }

  @Test("an ambiguous PATCH reports a newer conflicting canonical revision")
  func conflictingRenameRecovery() async throws {
    let current = summary(title: "Someone else's title", revision: 3)
    URLProtocolStub.enqueue(failure: URLError(.timedOut))
    URLProtocolStub.enqueue(status: 200, data: try encode(current))
    let service = makeService(store: try PersistenceStore.inMemory())

    let error = await gatewayError {
      try await service.rename(id: current.id, title: "My title", revision: 2)
    }

    #expect(error == .revisionConflict(current: current))
    #expect(URLProtocolStub.requests.map(\.httpMethod) == ["PATCH", "GET"])
  }

  @Test("ambiguous DELETE distinguishes landed and unlanded outcomes")
  func deleteOutcomeRecovery() async throws {
    let base = summary(revision: 2)
    let tombstone = summary(revision: 3, status: .deleted)
    URLProtocolStub.enqueue(failure: URLError(.timedOut))
    URLProtocolStub.enqueue(status: 200, data: try encode(base))
    URLProtocolStub.enqueue(status: 200, data: try encode(tombstone))
    let store = try PersistenceStore.inMemory()
    let service = makeService(store: store)

    let retried = try await service.delete(id: base.id, revision: base.revision)

    #expect(retried == tombstone)
    #expect(URLProtocolStub.requests.map(\.httpMethod) == ["DELETE", "GET", "DELETE"])
    #expect(try await store.conversation(gatewayID: gatewayID, id: base.id)?.summary == tombstone)

    URLProtocolStub.reset()
    URLProtocolStub.enqueue(failure: URLError(.timedOut))
    URLProtocolStub.enqueue(status: 200, data: try encode(tombstone))
    let landed = try await makeService(store: try PersistenceStore.inMemory()).delete(
      id: base.id,
      revision: base.revision
    )

    #expect(landed == tombstone)
    #expect(URLProtocolStub.requests.map(\.httpMethod) == ["DELETE", "GET"])
  }

  @Test("an ambiguous DELETE retry timeout resolves the canonical tombstone")
  func ambiguousDeleteRetryRecovery() async throws {
    let base = summary(revision: 2)
    let tombstone = summary(revision: 3, status: .deleted)
    URLProtocolStub.enqueue(failure: URLError(.timedOut))
    URLProtocolStub.enqueue(status: 200, data: try encode(base))
    URLProtocolStub.enqueue(failure: URLError(.timedOut))
    URLProtocolStub.enqueue(status: 200, data: try encode(tombstone))
    let service = makeService(store: try PersistenceStore.inMemory())

    let result = try await service.delete(id: base.id, revision: base.revision)

    #expect(result == tombstone)
    #expect(URLProtocolStub.requests.map(\.httpMethod) == ["DELETE", "GET", "DELETE", "GET"])
  }

  @Test("a DELETE retry 410 resolves the canonical tombstone")
  func deleteRetryTombstoneRecovery() async throws {
    let base = summary(revision: 2)
    let tombstone = summary(revision: 3, status: .deleted)
    URLProtocolStub.enqueue(failure: URLError(.timedOut))
    URLProtocolStub.enqueue(status: 200, data: try encode(base))
    try URLProtocolStub.enqueue(status: 410, fixture: "errors/not-found.json")
    URLProtocolStub.enqueue(status: 200, data: try encode(tombstone))
    let service = makeService(store: try PersistenceStore.inMemory())

    let result = try await service.delete(id: base.id, revision: base.revision)

    #expect(result == tombstone)
    #expect(URLProtocolStub.requests.map(\.httpMethod) == ["DELETE", "GET", "DELETE", "GET"])
  }

  @Test("a DELETE retry not-found with an active point read requires an update")
  func deleteRetryNotFoundActiveRecovery() async throws {
    let base = summary(revision: 2)
    URLProtocolStub.enqueue(failure: URLError(.timedOut))
    URLProtocolStub.enqueue(status: 200, data: try encode(base))
    try URLProtocolStub.enqueue(status: 404, fixture: "errors/not-found.json")
    URLProtocolStub.enqueue(status: 200, data: try encode(base))
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations([base], gatewayID: gatewayID)
    let service = makeService(store: store)

    let error = await gatewayError {
      try await service.delete(id: base.id, revision: base.revision)
    }

    #expect(error == .updateRequired)
    #expect(URLProtocolStub.requests.map(\.httpMethod) == ["DELETE", "GET", "DELETE", "GET"])
    #expect(try await store.conversation(gatewayID: gatewayID, id: base.id)?.summary == base)
  }

  @Test("a landed mutation survives one local persistence failure")
  func persistenceFailureRecovery() async throws {
    let renamed = summary(title: "Persisted after recovery", revision: 3)
    URLProtocolStub.enqueue(status: 200, data: try encode(renamed))
    URLProtocolStub.enqueue(status: 200, data: try encode(renamed))
    let store = FailingConversationListPersistence(failMutationWrites: 1)
    let service = makeService(store: store)

    let result = try await service.rename(id: renamed.id, title: renamed.title, revision: 2)

    #expect(result == renamed)
    #expect(await store.mutationWriteAttempts == 2)
    #expect(await store.storedConversation == renamed)
    #expect(URLProtocolStub.requests.map(\.httpMethod) == ["PATCH", "GET"])
  }

  @Test("shutdown rejects new work before it reaches the transport")
  func shutdownRejectsNewWork() async throws {
    let service = makeService(store: try PersistenceStore.inMemory())
    await service.shutdown()

    do {
      _ = try await service.rename(id: "conversation", title: "No", revision: 1)
      Issue.record("Expected cancellation")
    } catch is CancellationError {
      // Expected.
    } catch {
      Issue.record("Expected cancellation, received \(error)")
    }

    #expect(URLProtocolStub.requests.isEmpty)
  }

  @Test("shutdown cancels and drains an in-flight request")
  func shutdownCancelsInFlightWork() async throws {
    let renamed = summary(title: "Never completes", revision: 3)
    URLProtocolStub.enqueue(
      status: 200,
      data: try encode(renamed),
      holdOpen: true
    )
    let service = makeService(store: try PersistenceStore.inMemory())
    let mutation = Task {
      try await service.rename(id: renamed.id, title: renamed.title, revision: 2)
    }
    try await waitForRequest()

    await service.shutdown()
    let result = await mutation.result

    try await waitForStopLoading()
    #expect(URLProtocolStub.stopLoadingCount > 0)
    guard case .failure(let error) = result else {
      Issue.record("Expected cancellation")
      return
    }
    #expect(error is CancellationError)
  }

  @Test("shutdown waits for in-flight persistence and rejects later writes")
  func shutdownDrainsPersistence() async throws {
    let renamed = summary(title: "Persist before shutdown", revision: 3)
    URLProtocolStub.enqueue(status: 200, data: try encode(renamed))
    let writeGate = TestGate()
    let store = GatedConversationListPersistence(writeGate: writeGate)
    let service = makeService(store: store)
    let mutation = Task {
      try await service.rename(id: renamed.id, title: renamed.title, revision: 2)
    }
    await writeGate.waitUntilWaiting()

    let completion = ShutdownCompletion()
    let shutdown = Task {
      await service.shutdown()
      await completion.finish()
    }
    for _ in 0..<20 { await Task.yield() }

    #expect(await completion.isFinished == false)
    #expect(await store.writeAttempts == 1)

    await writeGate.release()
    await shutdown.value
    let result = await mutation.result

    #expect(await completion.isFinished)
    #expect(await store.storedConversation == renamed)
    guard case .failure(let error) = result else {
      Issue.record("Expected lifecycle cancellation after persistence drained")
      return
    }
    #expect(error is CancellationError)

    do {
      _ = try await service.rename(id: renamed.id, title: "Too late", revision: 3)
      Issue.record("Expected cancellation")
    } catch is CancellationError {
      // Expected.
    }
    #expect(await store.writeAttempts == 1)
  }

  private func makeService(
    store: any ConversationListPersisting
  ) -> LiveConversationListService {
    let suiteName = "ConversationListServiceTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName) ?? .standard
    let api = makeAPI()
    return LiveConversationListService(
      gatewayID: gatewayID,
      store: store,
      pendingCreates: PendingConversationCreateStore(defaults: defaults),
      makeAPI: { api }
    )
  }

  private func makeAPI() -> GatewayAPI {
    let profile = ConnectionProfile(
      id: UUID(),
      gatewayId: gatewayID,
      publicKey: "public-key",
      label: "Test Gateway",
      host: "gateway.test",
      managementPort: 9400,
      chatPort: 9400,
      secure: true,
      mode: .lan,
      tlsCertificateSha256:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      createdAt: Date(timeIntervalSince1970: 0),
      lastSuccessfulSyncAt: nil
    )
    let secrets = ConnectionSecrets(
      managementToken: "management-test-token",
      chatToken: "chat-test-token",
      relayCredential: nil
    )
    return GatewayAPI(
      transport: HTTPTransport(
        endpoint: ConnectionEndpoint(profile: profile, secrets: secrets),
        secrets: secrets,
        session: testURLSession(),
        clock: TestAppClock(now: Date(timeIntervalSince1970: 0))
      )
    )
  }

  private func encode(_ value: ConversationSummaryDTO) throws -> Data {
    try ContractCoding.encoder().encode(value)
  }

  private func summary(
    title: String = "Conversation",
    revision: Int,
    status: ConversationStatus = .idle
  ) -> ConversationSummaryDTO {
    ConversationSummaryDTO(
      id: "conversation",
      agentId: "agent-1",
      agentName: "Agent one",
      title: title,
      revision: revision,
      status: status,
      activeTurnId: nil,
      owningIssueId: nil,
      projectId: nil,
      lastSeq: 0,
      lastMessagePreview: "Preview",
      createdAt: Date(timeIntervalSince1970: 10),
      updatedAt: Date(timeIntervalSince1970: TimeInterval(revision * 10)),
      deletedAt: status == .deleted ? Date(timeIntervalSince1970: 30) : nil
    )
  }

  private func gatewayError<Value: Sendable>(
    _ operation: @Sendable () async throws -> Value
  ) async -> GatewayError? {
    do {
      _ = try await operation()
      Issue.record("Expected GatewayError")
      return nil
    } catch let error as GatewayError {
      return error
    } catch {
      Issue.record("Expected GatewayError, received \(error)")
      return nil
    }
  }

  private func waitForRequest() async throws {
    for _ in 0..<100 {
      if URLProtocolStub.requests.isEmpty == false { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("Timed out waiting for the request")
  }

  private func waitForStopLoading() async throws {
    for _ in 0..<100 {
      if URLProtocolStub.stopLoadingCount > 0 { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("Timed out waiting for URLProtocol cancellation")
  }
}

private enum TestPersistenceFailure: Error {
  case writeFailed
}

private actor ShutdownCompletion {
  private(set) var isFinished = false

  func finish() {
    isFinished = true
  }
}

private actor GatedConversationListPersistence: ConversationListPersisting {
  private let writeGate: TestGate
  private(set) var writeAttempts = 0
  private(set) var storedConversation: ConversationSummaryDTO?

  init(writeGate: TestGate) {
    self.writeGate = writeGate
  }

  func conversations(gatewayID: String, limit: Int) -> [CachedConversation] { [] }
  func agents(gatewayID: String) -> [RegisteredAgentDTO] { [] }
  func replaceAgents(_ values: [RegisteredAgentDTO], gatewayID: String) {}
  func upsertAgent(_ value: RegisteredAgentDTO, gatewayID: String) {}
  func removeAgent(gatewayID: String, agentID: String) {}

  func upsertConversations(
    _ values: [ConversationSummaryDTO],
    gatewayID: String
  ) async {
    _ = gatewayID
    writeAttempts += 1
    await writeGate.wait()
    storedConversation = values.first
  }

  func applyTombstone(_ value: ConversationSummaryDTO, gatewayID: String) async {
    _ = gatewayID
    writeAttempts += 1
    await writeGate.wait()
    storedConversation = value
  }

  func removeConversation(gatewayID: String, conversationID: String) {}
}

private actor FailingConversationListPersistence: ConversationListPersisting {
  private let failMutationWrites: Int
  private(set) var mutationWriteAttempts = 0
  private(set) var storedConversation: ConversationSummaryDTO?

  init(failMutationWrites: Int) {
    self.failMutationWrites = failMutationWrites
  }

  func conversations(gatewayID: String, limit: Int) -> [CachedConversation] { [] }

  func agents(gatewayID: String) -> [RegisteredAgentDTO] { [] }

  func replaceAgents(_ values: [RegisteredAgentDTO], gatewayID: String) {}

  func upsertAgent(_ value: RegisteredAgentDTO, gatewayID: String) {}

  func removeAgent(gatewayID: String, agentID: String) {}

  func upsertConversations(_ values: [ConversationSummaryDTO], gatewayID: String) throws {
    try write(values.first)
  }

  func applyTombstone(_ value: ConversationSummaryDTO, gatewayID: String) throws {
    try write(value)
  }

  func removeConversation(gatewayID: String, conversationID: String) {}

  private func write(_ value: ConversationSummaryDTO?) throws {
    mutationWriteAttempts += 1
    if mutationWriteAttempts <= failMutationWrites {
      throw TestPersistenceFailure.writeFailed
    }
    storedConversation = value
  }
}
