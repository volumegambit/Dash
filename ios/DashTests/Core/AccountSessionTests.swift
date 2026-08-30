import CryptoKit
import Foundation
import Testing

@testable import Dash

private struct PresenterFixtureError: Error, Sendable {}

private actor FakeWebAuthPresenter: WebAuthPresenting {
  enum Behavior: Sendable {
    case echoState(code: String)
    case wrongState(code: String)
    case wrongScheme(code: String)
    case fail(any Error & Sendable)
  }

  private let behavior: Behavior
  private(set) var lastAuthorizeURL: URL?
  private(set) var lastCallbackScheme: String?

  init(_ behavior: Behavior) {
    self.behavior = behavior
  }

  func authenticate(url: URL, callbackScheme: String) async throws -> URL {
    lastAuthorizeURL = url
    lastCallbackScheme = callbackScheme
    switch behavior {
    case .echoState(let code):
      let state = try requireState(in: url)
      return try callbackURL(scheme: callbackScheme, code: code, state: state)
    case .wrongState(let code):
      return try callbackURL(scheme: callbackScheme, code: code, state: "some-other-state")
    case .wrongScheme(let code):
      // Echo the real state so the failure is attributable purely to the
      // scheme mismatch, not a state mismatch.
      let state = try requireState(in: url)
      return try callbackURL(scheme: "https", code: code, state: state)
    case .fail(let error):
      throw error
    }
  }

  private func requireState(in url: URL) throws -> String {
    guard
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let state = components.queryItems?.first(where: { $0.name == "state" })?.value
    else {
      throw PresenterFixtureError()
    }
    return state
  }

  private func callbackURL(scheme: String, code: String, state: String) throws -> URL {
    var components = URLComponents()
    components.scheme = scheme
    components.host = "oauth-callback"
    components.queryItems = [
      URLQueryItem(name: "code", value: code),
      URLQueryItem(name: "state", value: state),
    ]
    guard let url = components.url else { throw PresenterFixtureError() }
    return url
  }
}

@Suite("Account session (PKCE)", .serialized)
struct AccountSessionTests {
  init() {
    URLProtocolStub.reset()
  }

  // MARK: - AccountAuthConfig

  @Test("config loads the three interpolated keys from a test bundle")
  func configLoadsFromBundle() throws {
    let config = try withConfigBundle([
      "DashClerkFrontendAPI": "example.clerk.accounts.dev",
      "DashClerkClientID": "client-123",
      "DashControlPlaneURL": "https://cp.example.com",
    ]) { bundle in
      try AccountAuthConfig.fromBundle(bundle)
    }

    #expect(config.frontendAPIHost == "example.clerk.accounts.dev")
    #expect(config.clientID == "client-123")
    #expect(config.controlPlaneURL == URL(string: "https://cp.example.com"))
    #expect(config.redirectURI == "dash://oauth-callback")
  }

  @Test("an entirely absent config key throws .missingKey with that key's name")
  func configAbsentKeyThrowsMissingKey() throws {
    try withConfigBundle([
      "DashClerkFrontendAPI": "example.clerk.accounts.dev",
      "DashControlPlaneURL": "https://cp.example.com",
      // DashClerkClientID intentionally omitted.
    ]) { bundle in
      #expect(throws: AccountAuthConfig.ConfigError.missingKey("DashClerkClientID")) {
        _ = try AccountAuthConfig.fromBundle(bundle)
      }
    }
  }

  @Test(
    """
    an xcconfig var that interpolates to an empty string throws .missingKey \
    (the real failure mode for an undefined build setting), not a decode crash
    """
  )
  func configEmptyStringValueThrowsMissingKey() throws {
    try withConfigBundle([
      "DashClerkFrontendAPI": "example.clerk.accounts.dev",
      "DashClerkClientID": "",
      "DashControlPlaneURL": "https://cp.example.com",
    ]) { bundle in
      #expect(throws: AccountAuthConfig.ConfigError.missingKey("DashClerkClientID")) {
        _ = try AccountAuthConfig.fromBundle(bundle)
      }
    }
  }

  // MARK: - signIn / PKCE

  @Test("signIn builds a PKCE authorize URL and exchanges the callback code for a token")
  func signInBuildsAuthorizeURLAndExchangesToken() async throws {
    let config = try makeConfig()
    let presenter = FakeWebAuthPresenter(.echoState(code: "abc"))
    URLProtocolStub.enqueue(
      status: 200,
      data: try tokenResponseData(idToken: "jwt-x", expiresIn: 3600)
    )
    let session = AccountSession(config: config, presenter: presenter, session: testURLSession())

    try await session.signIn()

    let authorizeURL = try #require(await presenter.lastAuthorizeURL)
    let authorizeComponents = try #require(
      URLComponents(url: authorizeURL, resolvingAgainstBaseURL: false)
    )
    #expect(authorizeComponents.scheme == "https")
    #expect(authorizeComponents.host == config.frontendAPIHost)
    #expect(authorizeComponents.path == "/oauth/authorize")
    let authorizeQuery = queryDictionary(authorizeComponents)
    #expect(authorizeQuery["client_id"] == config.clientID)
    #expect(authorizeQuery["redirect_uri"] == "dash://oauth-callback")
    #expect(authorizeQuery["code_challenge_method"] == "S256")
    let codeChallenge = try #require(authorizeQuery["code_challenge"])
    #expect(codeChallenge.isEmpty == false)
    #expect(await presenter.lastCallbackScheme == "dash")

    let requests = URLProtocolStub.requests
    #expect(requests.count == 1)
    let tokenRequest = requests[0]
    #expect(tokenRequest.httpMethod == "POST")
    #expect(tokenRequest.url?.host == config.frontendAPIHost)
    #expect(try encodedPath(tokenRequest) == "/oauth/token")
    let body = try formBody(tokenRequest)
    #expect(body["grant_type"] == "authorization_code")
    #expect(body["code"] == "abc")
    #expect(body["client_id"] == config.clientID)
    #expect(body["redirect_uri"] == "dash://oauth-callback")
    let verifier = try #require(body["code_verifier"])
    #expect(codeChallengeS256(for: verifier) == codeChallenge)

    #expect(try await session.idToken() == "jwt-x")
    #expect(await session.isSignedIn == true)
  }

  @Test("two signIn() calls generate distinct, RFC 7636-sized PKCE material")
  func signInGeneratesFreshPKCEMaterialEachTime() async throws {
    let config = try makeConfig()
    let presenter = FakeWebAuthPresenter(.echoState(code: "abc"))
    URLProtocolStub.enqueue(
      status: 200,
      data: try tokenResponseData(idToken: "jwt-1", expiresIn: 3600)
    )
    URLProtocolStub.enqueue(
      status: 200,
      data: try tokenResponseData(idToken: "jwt-2", expiresIn: 3600)
    )
    let session = AccountSession(config: config, presenter: presenter, session: testURLSession())

    try await session.signIn()
    let firstRequest = try #require(URLProtocolStub.requests.first)
    let firstBody = try formBody(firstRequest)
    let firstVerifier = try #require(firstBody["code_verifier"])
    let firstAuthorizeURL = try #require(await presenter.lastAuthorizeURL)
    let firstAuthorizeComponents = try #require(
      URLComponents(url: firstAuthorizeURL, resolvingAgainstBaseURL: false)
    )
    let firstState = try #require(queryDictionary(firstAuthorizeComponents)["state"])

    try await session.signIn()
    let secondRequest = try #require(URLProtocolStub.requests.last)
    let secondBody = try formBody(secondRequest)
    let secondVerifier = try #require(secondBody["code_verifier"])
    let secondAuthorizeURL = try #require(await presenter.lastAuthorizeURL)
    let secondAuthorizeComponents = try #require(
      URLComponents(url: secondAuthorizeURL, resolvingAgainstBaseURL: false)
    )
    let secondState = try #require(queryDictionary(secondAuthorizeComponents)["state"])

    #expect(firstVerifier != secondVerifier)
    #expect(firstState != secondState)
    #expect((43...128).contains(firstVerifier.count))
    #expect((43...128).contains(secondVerifier.count))
  }

  @Test("the token exchange body percent-encodes a literal '+' in a parameter value")
  func tokenExchangeEncodesPlusInBody() async throws {
    let config = try makeConfig()
    let presenter = FakeWebAuthPresenter(.echoState(code: "abc+def"))
    URLProtocolStub.enqueue(
      status: 200,
      data: try tokenResponseData(idToken: "jwt-x", expiresIn: 3600)
    )
    let session = AccountSession(config: config, presenter: presenter, session: testURLSession())

    try await session.signIn()

    let request = try #require(URLProtocolStub.requests.last)
    let rawBody = String(decoding: try #require(request.httpBody), as: UTF8.self)
    #expect(rawBody.contains("code=abc%2Bdef"))
    #expect(rawBody.contains("code=abc+def") == false)
    #expect(try formBody(request)["code"] == "abc+def")
  }

  @Test("a callback with a mismatched state is rejected before any network call")
  func signInRejectsMismatchedState() async throws {
    let config = try makeConfig()
    let presenter = FakeWebAuthPresenter(.wrongState(code: "abc"))
    let session = AccountSession(config: config, presenter: presenter, session: testURLSession())

    #expect(
      await accountSessionError { try await session.signIn() } == .invalidCallback
    )
    #expect(URLProtocolStub.requests.isEmpty)
    #expect(await session.isSignedIn == false)
  }

  @Test("a callback whose scheme doesn't match the redirect URI's is rejected as an invalid callback")
  func signInRejectsWrongSchemeCallback() async throws {
    let config = try makeConfig()
    let presenter = FakeWebAuthPresenter(.wrongScheme(code: "abc"))
    let session = AccountSession(config: config, presenter: presenter, session: testURLSession())

    #expect(
      await accountSessionError { try await session.signIn() } == .invalidCallback
    )
    #expect(URLProtocolStub.requests.isEmpty)
    #expect(await session.isSignedIn == false)
  }

  @Test("a WebAuthCancelled presenter failure maps to .cancelled and leaves the session signed out")
  func presenterCancelledSentinelMapsToCancelled() async throws {
    let config = try makeConfig()
    let presenter = FakeWebAuthPresenter(.fail(WebAuthCancelled()))
    let session = AccountSession(config: config, presenter: presenter, session: testURLSession())

    #expect(
      await accountSessionError { try await session.signIn() } == .cancelled
    )
    #expect(URLProtocolStub.requests.isEmpty)
    #expect(await session.isSignedIn == false)
  }

  @Test(
    "a non-cancellation presenter failure maps to .exchangeFailed (never .cancelled) and leaves the session signed out"
  )
  func presenterOtherFailureMapsToExchangeFailed() async throws {
    struct PresentationContextMissing: Error, Sendable {}
    let config = try makeConfig()
    let presenter = FakeWebAuthPresenter(.fail(PresentationContextMissing()))
    let session = AccountSession(config: config, presenter: presenter, session: testURLSession())

    #expect(
      await accountSessionError { try await session.signIn() } == .exchangeFailed
    )
    #expect(URLProtocolStub.requests.isEmpty)
    #expect(await session.isSignedIn == false)
  }

  @Test("a non-2xx token exchange response maps to .exchangeFailed")
  func tokenExchangeFailureMapsToExchangeFailed() async throws {
    let config = try makeConfig()
    let presenter = FakeWebAuthPresenter(.echoState(code: "abc"))
    URLProtocolStub.enqueue(status: 400, data: Data("{}".utf8))
    let session = AccountSession(config: config, presenter: presenter, session: testURLSession())

    #expect(
      await accountSessionError { try await session.signIn() } == .exchangeFailed
    )
    #expect(await session.isSignedIn == false)
  }

  // MARK: - idToken caching / expiry

  @Test("idToken throws .signInRequired before any sign-in")
  func idTokenRequiresSignInFirst() async throws {
    let config = try makeConfig()
    let presenter = FakeWebAuthPresenter(.echoState(code: "abc"))
    let session = AccountSession(config: config, presenter: presenter, session: testURLSession())

    #expect(
      await accountSessionError { _ = try await session.idToken() } == .signInRequired
    )
  }

  @Test("idToken throws .signInRequired once the injected clock passes the ~60s expiry skew")
  func idTokenExpiresNearRecordedExpiry() async throws {
    let config = try makeConfig()
    let presenter = FakeWebAuthPresenter(.echoState(code: "abc"))
    URLProtocolStub.enqueue(
      status: 200,
      data: try tokenResponseData(idToken: "jwt-x", expiresIn: 3600)
    )
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 0))
    let session = AccountSession(
      config: config,
      presenter: presenter,
      session: testURLSession(),
      clock: clock
    )

    try await session.signIn()
    #expect(try await session.idToken() == "jwt-x")

    await clock.setNow(Date(timeIntervalSince1970: 3600 - 30))

    #expect(
      await accountSessionError { _ = try await session.idToken() } == .signInRequired
    )
    #expect(await session.isSignedIn == false)
  }

  @Test("signOut drops the cached token")
  func signOutDropsToken() async throws {
    let config = try makeConfig()
    let presenter = FakeWebAuthPresenter(.echoState(code: "abc"))
    URLProtocolStub.enqueue(
      status: 200,
      data: try tokenResponseData(idToken: "jwt-x", expiresIn: 3600)
    )
    let session = AccountSession(config: config, presenter: presenter, session: testURLSession())
    try await session.signIn()
    #expect(await session.isSignedIn == true)

    await session.signOut()

    #expect(await session.isSignedIn == false)
    #expect(
      await accountSessionError { _ = try await session.idToken() } == .signInRequired
    )
  }
}

// MARK: - Helpers

private func makeConfig(
  frontendAPIHost: String = "resolved-seahorse-39.clerk.accounts.dev",
  clientID: String = "test-client-id",
  controlPlaneURL: String = "https://api.dash.example"
) throws -> AccountAuthConfig {
  try withConfigBundle([
    "DashClerkFrontendAPI": frontendAPIHost,
    "DashClerkClientID": clientID,
    "DashControlPlaneURL": controlPlaneURL,
  ]) { bundle in
    try AccountAuthConfig.fromBundle(bundle)
  }
}

/// Writes `entries` as a standalone `Info.plist` in a fresh temp directory,
/// loads it as a `Bundle`, hands it to `body`, and always removes the
/// directory afterward (success or throw) so repeated test runs don't leak
/// scratch directories under `/tmp`.
private func withConfigBundle<T>(
  _ entries: [String: String],
  _ body: (Bundle) throws -> T
) throws -> T {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("AccountAuthConfigTests-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }

  let data = try PropertyListSerialization.data(fromPropertyList: entries, format: .xml, options: 0)
  try data.write(to: directory.appendingPathComponent("Info.plist"))
  let bundle = try #require(Bundle(url: directory))
  return try body(bundle)
}

private func tokenResponseData(idToken: String, expiresIn: Int) throws -> Data {
  try JSONSerialization.data(withJSONObject: [
    "id_token": idToken,
    "expires_in": expiresIn,
  ])
}

private func codeChallengeS256(for verifier: String) -> String {
  let digest = SHA256.hash(data: Data(verifier.utf8))
  return Data(digest).base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

private func queryDictionary(_ components: URLComponents) -> [String: String] {
  var result: [String: String] = [:]
  for item in components.queryItems ?? [] {
    result[item.name] = item.value
  }
  return result
}

/// Decodes an `application/x-www-form-urlencoded` body the way a spec-correct
/// server would: `+` means a literal space, so it's translated before percent
/// decoding — a percent-encoded `+` (`%2B`) is unaffected and comes back as
/// `+`, distinguishing it from an actual space.
private func formBody(_ request: URLRequest) throws -> [String: String] {
  let data = try #require(request.httpBody)
  let string = String(decoding: data, as: UTF8.self)
  var result: [String: String] = [:]
  for pair in string.split(separator: "&") {
    let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
    guard parts.count == 2 else { continue }
    result[decodeFormComponent(String(parts[0]))] = decodeFormComponent(String(parts[1]))
  }
  return result
}

private func decodeFormComponent(_ value: String) -> String {
  value.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? value
}

private func encodedPath(_ request: URLRequest) throws -> String {
  let url = try #require(request.url)
  return try #require(URLComponents(url: url, resolvingAgainstBaseURL: false)).percentEncodedPath
}

private func accountSessionError(
  _ operation: () async throws -> Void
) async -> AccountSessionError? {
  do {
    try await operation()
    Issue.record("Expected AccountSessionError")
    return nil
  } catch let error as AccountSessionError {
    return error
  } catch {
    Issue.record("Expected AccountSessionError, received \(error)")
    return nil
  }
}
