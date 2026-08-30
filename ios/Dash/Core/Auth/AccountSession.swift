import CryptoKit
import Foundation
import Security

/// Presents a system auth sheet for a URL and resolves with the full callback
/// URL once the redirect fires (concretely `ASWebAuthenticationSession` in a
/// later task; a fake in tests).
///
/// Throw `WebAuthCancelled` when the user dismisses the sheet — that is the
/// only failure `AccountSession` treats as a user-initiated cancel. Any other
/// error (a missing presentation context, a transport failure, etc.) is
/// surfaced as `.exchangeFailed` so it isn't silently mistaken for cancel.
protocol WebAuthPresenting: Sendable {
  func authenticate(url: URL, callbackScheme: String) async throws -> URL
}

/// Sentinel thrown by a `WebAuthPresenting` conformer to signal that the user
/// dismissed the auth sheet (as opposed to some other presentation failure).
struct WebAuthCancelled: Error, Equatable, Sendable {
  init() {}
}

enum AccountSessionError: Error, Equatable {
  case signInRequired
  case cancelled
  case exchangeFailed
  case invalidCallback
}

/// Clerk PKCE account sign-in session. Mirrors Mission Control's documented
/// loopback-OAuth flow (`packages/mc/src/runtime/control-plane-session.ts`),
/// substituting a custom-scheme redirect for the loopback HTTP server: the
/// Clerk `id_token` returned from the token exchange is the control-plane
/// bearer. The token lives only in memory for the process lifetime — nothing
/// is persisted here.
actor AccountSession {
  /// Refresh this many seconds before the recorded expiry to avoid edge races.
  private static let expirySkew: TimeInterval = 60

  private let config: AccountAuthConfig
  private let presenter: any WebAuthPresenting
  private let session: URLSession
  private let clock: any AppClock

  private var cachedIDToken: String?
  private var cachedExpiresAt: Date?

  init(
    config: AccountAuthConfig,
    presenter: any WebAuthPresenting,
    session: URLSession = .shared,
    clock: any AppClock = SystemAppClock()
  ) {
    self.config = config
    self.presenter = presenter
    self.session = session
    self.clock = clock
  }

  #if DEBUG
    /// Test-only: seeds the actor with an already-valid cached token so
    /// UI-test scenarios can reach the signed-in `GatewayPickerView` without a
    /// live PKCE round trip. `presenter`/`session` still back a real sign-out
    /// → sign-in-again path if a test ever exercises one.
    init(
      preSignedInWithIDToken idToken: String,
      expiresAt: Date,
      config: AccountAuthConfig,
      presenter: any WebAuthPresenting,
      session: URLSession = .shared,
      clock: any AppClock = SystemAppClock()
    ) {
      self.config = config
      self.presenter = presenter
      self.session = session
      self.clock = clock
      self.cachedIDToken = idToken
      self.cachedExpiresAt = expiresAt
    }
  #endif

  var isSignedIn: Bool {
    get async {
      (try? await currentToken()) != nil
    }
  }

  /// Runs the full PKCE flow: generate a verifier/challenge pair, build the
  /// authorize URL, present it, validate the callback's `state`, and exchange
  /// the returned `code` for an `id_token`.
  func signIn() async throws {
    let verifier = Self.makeCodeVerifier()
    let challenge = Self.codeChallenge(for: verifier)
    let state = Self.makeState()
    let authorizeURL = try makeAuthorizeURL(state: state, codeChallenge: challenge)
    let callbackScheme = Self.scheme(forRedirectURI: config.redirectURI)

    let callbackURL: URL
    do {
      callbackURL = try await presenter.authenticate(url: authorizeURL, callbackScheme: callbackScheme)
    } catch is WebAuthCancelled {
      throw AccountSessionError.cancelled
    } catch {
      throw AccountSessionError.exchangeFailed
    }

    let code = try Self.code(
      fromCallback: callbackURL,
      expectedState: state,
      expectedScheme: callbackScheme
    )
    let tokenResponse = try await exchangeCode(code, verifier: verifier)

    cachedIDToken = tokenResponse.idToken
    cachedExpiresAt = await clock.now().addingTimeInterval(TimeInterval(tokenResponse.expiresIn))
  }

  /// Returns the cached `id_token`, refreshed until ~60s before its recorded
  /// expiry. Throws `.signInRequired` when absent or expired — this actor does
  /// not silently re-run the interactive flow.
  func idToken() async throws -> String {
    try await currentToken()
  }

  func signOut() {
    cachedIDToken = nil
    cachedExpiresAt = nil
  }

  private func currentToken() async throws -> String {
    guard let token = cachedIDToken, let expiresAt = cachedExpiresAt else {
      throw AccountSessionError.signInRequired
    }
    let now = await clock.now()
    guard now < expiresAt.addingTimeInterval(-Self.expirySkew) else {
      throw AccountSessionError.signInRequired
    }
    return token
  }

  private func makeAuthorizeURL(state: String, codeChallenge: String) throws -> URL {
    var components = URLComponents()
    components.scheme = "https"
    components.host = config.frontendAPIHost
    components.path = "/oauth/authorize"
    components.queryItems = [
      URLQueryItem(name: "response_type", value: "code"),
      URLQueryItem(name: "client_id", value: config.clientID),
      URLQueryItem(name: "redirect_uri", value: config.redirectURI),
      URLQueryItem(name: "state", value: state),
      URLQueryItem(name: "code_challenge", value: codeChallenge),
      URLQueryItem(name: "code_challenge_method", value: "S256"),
    ]
    guard let url = components.url else {
      throw AccountSessionError.exchangeFailed
    }
    return url
  }

  private static func code(
    fromCallback callbackURL: URL,
    expectedState: String,
    expectedScheme: String
  ) throws -> String {
    guard
      let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
      components.scheme == expectedScheme
    else {
      throw AccountSessionError.invalidCallback
    }
    let query = components.queryItems ?? []
    guard
      let returnedState = query.first(where: { $0.name == "state" })?.value,
      returnedState == expectedState
    else {
      throw AccountSessionError.invalidCallback
    }
    guard let code = query.first(where: { $0.name == "code" })?.value else {
      throw AccountSessionError.invalidCallback
    }
    return code
  }

  private struct TokenResponse: Decodable {
    let idToken: String
    let expiresIn: Int

    enum CodingKeys: String, CodingKey {
      case idToken = "id_token"
      case expiresIn = "expires_in"
    }
  }

  private func exchangeCode(_ code: String, verifier: String) async throws -> TokenResponse {
    var components = URLComponents()
    components.scheme = "https"
    components.host = config.frontendAPIHost
    components.path = "/oauth/token"
    guard let url = components.url else {
      throw AccountSessionError.exchangeFailed
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")

    request.httpBody = Self.formURLEncodedBody([
      ("grant_type", "authorization_code"),
      ("code", code),
      ("client_id", config.clientID),
      ("redirect_uri", config.redirectURI),
      ("code_verifier", verifier),
    ])

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw AccountSessionError.exchangeFailed
    }
    guard
      let httpResponse = response as? HTTPURLResponse,
      (200..<300).contains(httpResponse.statusCode)
    else {
      throw AccountSessionError.exchangeFailed
    }
    do {
      return try JSONDecoder().decode(TokenResponse.self, from: data)
    } catch {
      throw AccountSessionError.exchangeFailed
    }
  }

  private static func scheme(forRedirectURI redirectURI: String) -> String {
    URLComponents(string: redirectURI)?.scheme ?? redirectURI
  }

  /// `application/x-www-form-urlencoded` characters that never need escaping.
  /// Notably excludes `+` — Clerk's `code` is opaque and may itself contain a
  /// literal `+`, which `URLComponents`' query-percent-encoding (RFC 3986,
  /// where `+` is a legal, unreserved query character) would leave
  /// unescaped, corrupting it under the `+` == space form convention.
  private static let formValueAllowedCharacters: CharacterSet = {
    var set = CharacterSet.alphanumerics
    set.insert(charactersIn: "-._*")
    return set
  }()

  private static func formEncode(_ value: String) -> String {
    let encoded = value.addingPercentEncoding(withAllowedCharacters: formValueAllowedCharacters)
      ?? value
    return encoded.replacingOccurrences(of: "%20", with: "+")
  }

  private static func formURLEncodedBody(_ parameters: [(name: String, value: String)]) -> Data {
    Data(
      parameters.map { "\(formEncode($0.name))=\(formEncode($0.value))" }
        .joined(separator: "&")
        .utf8
    )
  }

  private static func makeCodeVerifier() -> String {
    randomBytes(count: 32).base64URLEncodedString()
  }

  private static func makeState() -> String {
    randomBytes(count: 16).base64URLEncodedString()
  }

  private static func codeChallenge(for verifier: String) -> String {
    let digest = SHA256.hash(data: Data(verifier.utf8))
    return Data(digest).base64URLEncodedString()
  }

  private static func randomBytes(count: Int) -> Data {
    var bytes = [UInt8](repeating: 0, count: count)
    let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
    precondition(status == errSecSuccess, "SecRandomCopyBytes failed with status \(status)")
    return Data(bytes)
  }
}

extension Data {
  fileprivate func base64URLEncodedString() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
