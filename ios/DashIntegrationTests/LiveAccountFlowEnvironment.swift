import Foundation

@testable import Dash

/// Reads the environment `ios/scripts/run-live-account-flow-test.mjs` injects
/// into the simulator before running `LiveAccountFlowTests`. Mirrors
/// `LiveGatewayEnvironment`'s shape and "throw when absent" convention (NOT an
/// `XCTSkip`) — running the `DashIntegration` scheme directly, without that
/// script, naturally fails this test with a `missing(...)` error, exactly like
/// the six other live-gateway tests fail without `DASH_TEST_MANAGEMENT_URL`.
/// That keeps the suite's pass/fail count honest about what actually ran.
enum LiveAccountFlowEnvironmentError: Error, Equatable, Sendable {
  case missing(String)
  case blank(String)
  case invalidURL(String)
  case invalidPort(String)
}

struct LiveAccountFlowEnvironment: Sendable {
  /// The (locally running, dev-stub-auth) control plane's base URL — actually
  /// the auth-shim in front of it, translating `Authorization: Bearer` into
  /// `x-test-account` the way a real Clerk-fronted deployment never needs to.
  let controlPlaneURL: URL
  /// Accepted verbatim by the control-plane dev stub as the account id.
  let bearer: String
  /// The gateway id (`ProvisioningService.createGateway`'s subdomain label)
  /// the orchestrating script registered and dialed into the relay — the
  /// control plane's/relay's routing identity for it.
  let gatewayID: String
  /// The scripted gateway's OWN self-reported identity (its `/identity`
  /// route's `gatewayId`), deliberately different from `gatewayID` above.
  /// `PairingVerifier.verify()` trusts this over the CP registration label,
  /// so the account-authenticated connect pipeline's installed profile ends
  /// up carrying this value, not `gatewayID`.
  let identityGatewayID: String
  /// The scripted agent id `mobile-test-harness.ts` always registers.
  let agentID: String
  /// The TLS terminator's high port (`applyingDebugRelayPortOverride`) — this
  /// host can bind neither 127.0.0.1:443 (EACCES, unprivileged) nor 0.0.0.0:443
  /// (owned by another local service), so the harness fronts the relay on a
  /// high port instead and this test tells `AccountConnectFeature`'s `#if
  /// DEBUG` override to target it.
  let relayPort: Int

  static func environment(_ values: [String: String]) throws -> Self {
    let controlPlaneURLValue = try required("DASH_TEST_ACCOUNT_CONTROL_PLANE_URL", in: values)
    let bearer = try required("DASH_TEST_ACCOUNT_BEARER", in: values)
    let gatewayID = try required("DASH_TEST_ACCOUNT_GATEWAY_ID", in: values)
    let identityGatewayID = try required("DASH_TEST_ACCOUNT_IDENTITY_GATEWAY_ID", in: values)
    let agentID = try required("DASH_TEST_ACCOUNT_AGENT_ID", in: values)
    let relayPortValue = try required("DASH_TEST_ACCOUNT_RELAY_PORT", in: values)
    guard
      let components = URLComponents(string: controlPlaneURLValue),
      components.scheme?.isEmpty == false,
      components.host?.isEmpty == false,
      let url = components.url
    else {
      throw LiveAccountFlowEnvironmentError.invalidURL("DASH_TEST_ACCOUNT_CONTROL_PLANE_URL")
    }
    guard let relayPort = Int(relayPortValue), (1...65_535).contains(relayPort) else {
      throw LiveAccountFlowEnvironmentError.invalidPort("DASH_TEST_ACCOUNT_RELAY_PORT")
    }
    return LiveAccountFlowEnvironment(
      controlPlaneURL: url,
      bearer: bearer,
      gatewayID: gatewayID,
      identityGatewayID: identityGatewayID,
      agentID: agentID,
      relayPort: relayPort
    )
  }

  static func processInfo(_ processInfo: ProcessInfo = .processInfo) throws -> Self {
    try environment(processInfo.environment)
  }

  private static func required(_ name: String, in values: [String: String]) throws -> String {
    guard let value = values[name] else {
      throw LiveAccountFlowEnvironmentError.missing(name)
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.isEmpty == false else {
      throw LiveAccountFlowEnvironmentError.blank(name)
    }
    return trimmed
  }
}

/// `WebAuthPresenting` never actually runs in this test — `AccountSession` is
/// seeded via its `#if DEBUG` `preSignedInWithIDToken` initializer (T7), which
/// bypasses the PKCE flow entirely. This conformer only exists to satisfy the
/// initializer's parameter list; if it's ever invoked, something regressed
/// (the token cache expired mid-test, or `signIn()` got called by mistake).
struct UnreachableWebAuthPresenter: WebAuthPresenting {
  func authenticate(url: URL, callbackScheme: String) async throws -> URL {
    throw WebAuthCancelled()
  }
}
