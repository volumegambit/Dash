import XCTest

@testable import Dash

final class HTTPAndSSEIntegrationTests: XCTestCase {
  func testHTTPAndSSE() async throws {
    let environment = try LiveGatewayEnvironment.processInfo()
    try XCTSkipUnless(environment.scenario == "stream", "Requires the stream harness")
    let client = try environment.makeClient()

    let health = try await client.api.health()
    XCTAssertTrue(health.capabilities.contains(.conversationSyncV1))
    XCTAssertTrue(health.capabilities.contains(.chatResumeV1))

    let identity = try await client.api.identity()
    XCTAssertEqual(identity.gatewayId, environment.gatewayID)
    let agents = try await client.api.listAgents()
    XCTAssertTrue(agents.contains { $0.id == environment.agentID })
    _ = try await client.api.models()

    try await verifyAgentLifecycle(
      api: client.api,
      existingAgentID: environment.agentID
    )

    let requestID = UUID().uuidString.lowercased()
    let create = CreateConversationRequest(
      agentId: environment.agentID,
      requestId: requestID,
      title: "iOS HTTP and SSE",
      owningIssueId: nil,
      projectId: nil
    )
    let created = try await client.api.createConversation(create)
    let retried = try await client.api.createConversation(create)
    XCTAssertEqual(retried.id, created.id)

    let invalidations = await LiveInvalidationRecording.start(client.sse)
    defer { invalidations.cancel() }

    let renamedRevision = try await LiveInvalidationRetryPolicy(
      maxAttempts: 4,
      observationTimeout: .seconds(1)
    ).run(
      initialRevision: created.revision,
      mutate: { revision, attempt in
        let renamed = try await client.api.patchConversation(
          id: created.id,
          request: PatchConversationRequest(title: "Renamed on iOS \(attempt)"),
          revision: revision
        )
        return renamed.revision
      },
      observe: { revision, timeout in
        do {
          _ = try await invalidations.recorder.waitFor(timeout: timeout) { event in
            event == .conversationChanged(conversationID: created.id, revision: revision)
          }
          return true
        } catch LiveGatewayTestError.timeout {
          return false
        }
      }
    )

    let tombstone = try await client.api.deleteConversation(
      id: created.id,
      revision: renamedRevision
    )
    let deleted = try await invalidations.recorder.waitFor { event in
      event
        == .conversationDeleted(conversationID: created.id, revision: tombstone.revision)
    }
    XCTAssertEqual(tombstone.status, .deleted)
    XCTAssertEqual(
      deleted,
      .conversationDeleted(conversationID: created.id, revision: tombstone.revision)
    )

    let page = try await client.api.conversations(agentId: nil, limit: 100, cursor: nil)
    XCTAssertFalse(page.items.contains { $0.id == created.id })

    let badClient = try environment.replacing(managementToken: "incorrect-token").makeClient()
    do {
      _ = try await badClient.api.identity()
      XCTFail("Expected the management request to be rejected")
    } catch {
      XCTAssertEqual(error as? GatewayError, .unauthorized)
    }
  }

  private func verifyAgentLifecycle(
    api: GatewayAPI,
    existingAgentID: String
  ) async throws {
    let name = "ios-http-sse-agent"
    let initialPrompt = "Initial iOS integration prompt."
    let updatedPrompt = "Updated iOS integration prompt."
    let created = try await api.createAgent(
      CreateAgentRequest(
        name: name,
        model: "test/scripted",
        systemPrompt: initialPrompt
      )
    )
    XCTAssertNotEqual(created.id, existingAgentID)
    XCTAssertEqual(created.name, name)
    XCTAssertEqual(created.config.model, "test/scripted")
    XCTAssertEqual(created.config.systemPrompt, initialPrompt)
    XCTAssertEqual(created.status, .registered)

    let fetched = try await api.agent(id: created.id)
    XCTAssertEqual(fetched, created)
    let listed = try await api.listAgents()
    XCTAssertEqual(listed.filter { $0.id == created.id }, [created])

    let updated = try await api.updateAgent(
      id: created.id,
      request: UpdateAgentRequest(model: nil, systemPrompt: updatedPrompt)
    )
    XCTAssertEqual(updated.id, created.id)
    XCTAssertEqual(updated.name, name)
    XCTAssertEqual(updated.config.model, "test/scripted")
    XCTAssertEqual(updated.config.systemPrompt, updatedPrompt)

    let conversation = try await api.createConversation(
      CreateConversationRequest(
        agentId: created.id,
        requestId: "ios-http-sse-agent-conversation",
        title: "iOS agent lifecycle",
        owningIssueId: nil,
        projectId: nil
      )
    )
    XCTAssertEqual(conversation.agentId, created.id)
    XCTAssertEqual(conversation.agentName, name)
    XCTAssertEqual(conversation.status, .idle)

    try await api.setAgentEnabled(id: created.id, enabled: false)
    let disabled = try await api.agent(id: created.id)
    XCTAssertEqual(disabled.status, .disabled)

    try await api.setAgentEnabled(id: created.id, enabled: true)
    let enabled = try await api.agent(id: created.id)
    XCTAssertEqual(enabled.status, .registered)
    XCTAssertEqual(enabled.config.systemPrompt, updatedPrompt)

    try await api.deleteAgent(id: created.id)
    let remaining = try await api.listAgents()
    XCTAssertFalse(remaining.contains { $0.id == created.id })
    do {
      _ = try await api.agent(id: created.id)
      XCTFail("Expected the deleted agent point read to fail")
    } catch {
      XCTAssertEqual(error as? GatewayError, .notFound)
    }

    let archived = try await api.conversation(id: conversation.id)
    XCTAssertEqual(archived.agentId, created.id)
    XCTAssertEqual(archived.agentName, name)
    XCTAssertEqual(archived.status, .archived)
    XCTAssertEqual(archived.revision, conversation.revision + 1)
    XCTAssertNil(archived.activeTurnId)
    let messages = try await api.messages(
      conversationID: conversation.id,
      limit: 100,
      before: nil
    )
    XCTAssertTrue(messages.items.isEmpty)

    do {
      _ = try await api.patchConversation(
        id: archived.id,
        request: PatchConversationRequest(title: "Archived mutation"),
        revision: archived.revision
      )
      XCTFail("Expected the archived conversation mutation to fail")
    } catch {
      XCTAssertEqual(
        error as? GatewayError,
        .validation("Archived conversations cannot be updated")
      )
    }
  }
}
