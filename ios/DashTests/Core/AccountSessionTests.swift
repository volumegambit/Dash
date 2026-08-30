import CryptoKit
import Foundation
import Testing

@testable import Dash

private struct FakeCancelError: Error, Sendable {}

private actor FakeWebAuthPresenter: WebAuthPresenting {
  enum Behavior: Sendable {
    case echoState(code: String)
    case wrongState(code: String)
    case fail(FakeCancelError)
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
    case .fail(let error):
      throw error
    }
  }

  private func requireState(in url: URL) throws -> String {
    guard
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let state = components.queryItems?.first(where: { $0.name == "state" })?.value
    else {
      throw FakeCancelError()
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
    guard let url = components.url else { throw FakeCancelError() }
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
    let bundle = try makeConfigBundle(
      frontendAPIHost: "example.clerk.accounts.dev",
      clientID: "client-123",
      controlPlaneURL: "https://cp.example.com"
    )

    let config = try AccountAuthConfig.fromBundle(bundle)

    #expect(config.frontendAPIHost == "example.clerk.accounts.dev")
    #expect(config.clientID == "client-123")
    #expect(config.controlPlaneURL == URL(string: "https://cp.example.com"))
    #expect(config.redirectURI == "dash://oauth-callback")
  }

  @Test("a missing config key throws")
  func configMissingKeyThrows() throws {
    let bundle = try makeConfigBundle(clientID: "")

    #expect(throws: AccountAuthConfig.ConfigError.self) {
      _ = try AccountAuthConfig.fromBundle(bundle)
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
    let authorizeQuery = try queryDictionary(authorizeComponents)
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

  @Test("a presenter failure (e.g. user cancel) maps to .cancelled and leaves the session signed out")
  func presenterFailureMapsToCancelled() async throws {
    let config = try makeConfig()
    let presenter = FakeWebAuthPresenter(.fail(FakeCancelError()))
    let session = AccountSession(config: config, presenter: presenter, session: testURLSession())

    #expect(
      await accountSessionError { try await session.signIn() } == .cancelled
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
  try AccountAuthConfig.fromBundle(
    makeConfigBundle(
      frontendAPIHost: frontendAPIHost,
      clientID: clientID,
      controlPlaneURL: controlPlaneURL
    )
  )
}

private func makeConfigBundle(
  frontendAPIHost: String = "resolved-seahorse-39.clerk.accounts.dev",
  clientID: String = "test-client-id",
  controlPlaneURL: String = "https://api.dash.example"
) throws -> Bundle {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("AccountAuthConfigTests-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  var plist: [String: Any] = [:]
  if frontendAPIHost.isEmpty == false {
    plist["DashClerkFrontendAPI"] = frontendAPIHost
  }
  if clientID.isEmpty == false {
    plist["DashClerkClientID"] = clientID
  }
  if controlPlaneURL.isEmpty == false {
    plist["DashControlPlaneURL"] = controlPlaneURL
  }
  let data = try PropertyListSerialization.data(
    fromPropertyList: plist,
    format: .xml,
    options: 0
  )
  try data.write(to: directory.appendingPathComponent("Info.plist"))
  return try #require(Bundle(url: directory))
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

private func queryDictionary(_ components: URLComponents) throws -> [String: String] {
  var result: [String: String] = [:]
  for item in components.queryItems ?? [] {
    result[item.name] = item.value
  }
  return result
}

private func formBody(_ request: URLRequest) throws -> [String: String] {
  let data = try #require(request.httpBody)
  var components = URLComponents()
  components.percentEncodedQuery = String(decoding: data, as: UTF8.self)
  return try queryDictionary(components)
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
