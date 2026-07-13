import XCTest

@testable import Dash

final class LiveGatewayEnvironmentTests: XCTestCase {
  private let completeEnvironment = [
    "DASH_TEST_MANAGEMENT_URL": "http://127.0.0.1:49100",
    "DASH_TEST_CHAT_URL": "ws://127.0.0.1:49200/ws/chat",
    "DASH_TEST_MANAGEMENT_TOKEN": "management-secret",
    "DASH_TEST_CHAT_TOKEN": "chat-secret",
    "DASH_TEST_GATEWAY_ID": "gateway-live-01",
    "DASH_TEST_AGENT_ID": "agent-live-01",
    "DASH_TEST_SCENARIO": "stream",
  ]

  func testEnvironmentMapsAllSevenVariables() throws {
    let environment = try LiveGatewayEnvironment.environment(completeEnvironment)

    XCTAssertEqual(environment.managementURL.absoluteString, "http://127.0.0.1:49100")
    XCTAssertEqual(environment.chatURL.absoluteString, "ws://127.0.0.1:49200/ws/chat")
    XCTAssertEqual(environment.managementToken, "management-secret")
    XCTAssertEqual(environment.chatToken, "chat-secret")
    XCTAssertEqual(environment.gatewayID, "gateway-live-01")
    XCTAssertEqual(environment.agentID, "agent-live-01")
    XCTAssertEqual(environment.scenario, "stream")
  }

  func testEnvironmentRejectsEveryMissingVariable() {
    for name in completeEnvironment.keys {
      var values = completeEnvironment
      values[name] = nil

      XCTAssertThrowsError(try LiveGatewayEnvironment.environment(values)) { error in
        XCTAssertTrue(error is LiveGatewayEnvironmentError)
      }
    }
  }

  func testEnvironmentRejectsEveryBlankVariable() {
    for name in completeEnvironment.keys {
      var values = completeEnvironment
      values[name] = " \n\t "

      XCTAssertThrowsError(try LiveGatewayEnvironment.environment(values)) { error in
        XCTAssertTrue(error is LiveGatewayEnvironmentError)
      }
    }
  }

  func testEnvironmentRejectsMalformedURLs() {
    for name in ["DASH_TEST_MANAGEMENT_URL", "DASH_TEST_CHAT_URL"] {
      var values = completeEnvironment
      values[name] = "not-an-absolute-url"

      XCTAssertThrowsError(try LiveGatewayEnvironment.environment(values)) { error in
        XCTAssertTrue(error is LiveGatewayEnvironmentError)
      }
    }
  }

  func testEnvironmentRejectsUnsupportedScenario() {
    var values = completeEnvironment
    values["DASH_TEST_SCENARIO"] = "other"

    XCTAssertThrowsError(try LiveGatewayEnvironment.environment(values)) { error in
      XCTAssertTrue(error is LiveGatewayEnvironmentError)
    }
  }

  func testMakeClientComposesProductionClientsOverOneStore() throws {
    let environment = try LiveGatewayEnvironment.environment(completeEnvironment)
    let client = try environment.makeClient()

    XCTAssertEqual(
      try client.endpoint.managementURL(path: "/", query: []).absoluteString,
      "http://127.0.0.1:49100/"
    )
    XCTAssertEqual(
      try client.endpoint.chatRequest().url?.absoluteString,
      "ws://127.0.0.1:49200/ws/chat?token=chat-secret"
    )
    XCTAssertTrue(client.store === client.conversationStore)
    XCTAssertTrue(client.store === client.syncStore)
  }

  func testInvalidationRetryCarriesRevisionUntilEventArrives() async throws {
    let probe = LiveInvalidationRetryProbe()
    let policy = LiveInvalidationRetryPolicy(
      maxAttempts: 3,
      observationTimeout: .milliseconds(10)
    )

    let revision = try await policy.run(
      initialRevision: 7,
      mutate: { revision, attempt in
        await probe.recordMutation(revision: revision, attempt: attempt)
        return revision + 1
      },
      observe: { revision, timeout in
        await probe.recordObservation(revision: revision, timeout: timeout)
        return revision == 9
      }
    )

    XCTAssertEqual(revision, 9)
    let snapshot = await probe.snapshot()
    XCTAssertEqual(snapshot.mutations.map(\.revision), [7, 8])
    XCTAssertEqual(snapshot.mutations.map(\.attempt), [1, 2])
    XCTAssertEqual(snapshot.observedRevisions, [8, 9])
    XCTAssertEqual(snapshot.observationTimeouts, [.milliseconds(10), .milliseconds(10)])
  }

  func testInvalidationRetryStopsAtAttemptLimit() async throws {
    let probe = LiveInvalidationRetryProbe()
    let policy = LiveInvalidationRetryPolicy(
      maxAttempts: 2,
      observationTimeout: .milliseconds(10)
    )

    do {
      _ = try await policy.run(
        initialRevision: 3,
        mutate: { revision, attempt in
          await probe.recordMutation(revision: revision, attempt: attempt)
          return revision + 1
        },
        observe: { revision, timeout in
          await probe.recordObservation(revision: revision, timeout: timeout)
          return false
        }
      )
      XCTFail("Expected bounded invalidation retries to time out")
    } catch {
      XCTAssertEqual(error as? LiveGatewayTestError, .timeout)
    }

    let snapshot = await probe.snapshot()
    XCTAssertEqual(snapshot.mutations.map(\.revision), [3, 4])
    XCTAssertEqual(snapshot.mutations.map(\.attempt), [1, 2])
    XCTAssertEqual(snapshot.observedRevisions, [4, 5])
  }
}

private actor LiveInvalidationRetryProbe {
  private var mutations: [(revision: Int, attempt: Int)] = []
  private var observedRevisions: [Int] = []
  private var observationTimeouts: [Duration] = []

  func recordMutation(revision: Int, attempt: Int) {
    mutations.append((revision, attempt))
  }

  func recordObservation(revision: Int, timeout: Duration) {
    observedRevisions.append(revision)
    observationTimeouts.append(timeout)
  }

  func snapshot() -> (
    mutations: [(revision: Int, attempt: Int)],
    observedRevisions: [Int],
    observationTimeouts: [Duration]
  ) {
    (mutations, observedRevisions, observationTimeouts)
  }
}
