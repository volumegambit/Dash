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
}
