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
}
