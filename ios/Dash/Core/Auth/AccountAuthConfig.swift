import Foundation

/// Static Clerk/control-plane configuration for account sign-in, resolved from
/// the app's Info.plist (itself interpolated from the active `.xcconfig`).
struct AccountAuthConfig: Sendable {
  /// Clerk Frontend API host, e.g. `resolved-seahorse-39.clerk.accounts.dev`.
  /// Authorize/token requests are made directly against `https://<host>`.
  let frontendAPIHost: String
  /// The OAuth application client id registered with Clerk.
  let clientID: String
  /// The Dash control plane's base URL (not used by the OAuth flow itself, but
  /// carried alongside since it's part of the same per-environment config).
  let controlPlaneURL: URL
  /// The app's registered custom-scheme redirect URI.
  let redirectURI: String

  enum ConfigError: Error, Equatable, Sendable {
    case missingKey(String)
    case invalidControlPlaneURL(String)
    /// The control-plane URL is still the committed placeholder from
    /// `Config/Base.xcconfig`. It parses, resolves to nothing, and would have
    /// turned every account request into an opaque network failure — so it is
    /// rejected at launch with a message that names the real fix instead.
    case placeholderControlPlaneURL(String)
  }

  private static let frontendAPIHostKey = "DashClerkFrontendAPI"
  private static let clientIDKey = "DashClerkClientID"
  private static let controlPlaneURLKey = "DashControlPlaneURL"
  private static let redirectURIValue = "dash://oauth-callback"
  /// The host `Config/Base.xcconfig` ships. It is a documentation-reserved
  /// name (RFC 2606 `.example`) that intentionally resolves nowhere — a build
  /// that still carries it was never pointed at a real deployment.
  private static let placeholderControlPlaneHost = "api.dash.example"

  /// Reads the three interpolated Info.plist keys from `bundle`.
  static func fromBundle(_ bundle: Bundle = .main) throws -> AccountAuthConfig {
    let frontendAPIHost = try requiredString(frontendAPIHostKey, in: bundle)
    let clientID = try requiredString(clientIDKey, in: bundle)
    let controlPlaneURLString = try requiredString(controlPlaneURLKey, in: bundle)
    guard let controlPlaneURL = URL(string: controlPlaneURLString) else {
      throw ConfigError.invalidControlPlaneURL(controlPlaneURLString)
    }
    // Deliberately checked AFTER parsing, so a malformed value still reports
    // the more specific `.invalidControlPlaneURL`. Host comparison (not a
    // substring match on the string) so a legitimate deployment that merely
    // mentions the placeholder in a path or query is unaffected.
    if controlPlaneURL.host?.lowercased() == placeholderControlPlaneHost {
      throw ConfigError.placeholderControlPlaneURL(controlPlaneURLString)
    }
    return AccountAuthConfig(
      frontendAPIHost: frontendAPIHost,
      clientID: clientID,
      controlPlaneURL: controlPlaneURL,
      redirectURI: redirectURIValue
    )
  }

  private static func requiredString(_ key: String, in bundle: Bundle) throws -> String {
    guard
      let value = bundle.object(forInfoDictionaryKey: key) as? String,
      value.isEmpty == false
    else {
      throw ConfigError.missingKey(key)
    }
    return value
  }
}

/// Honest, user-facing text for a build that cannot talk to any control plane.
/// `AppLaunch` surfaces `localizedDescription` verbatim, and the default for a
/// bare Swift `Error` ("The operation couldn't be completed…") would tell a
/// user nothing — these say exactly what is wrong and who can fix it.
extension AccountAuthConfig.ConfigError: LocalizedError {
  var errorDescription: String? {
    switch self {
    case .missingKey(let key):
      return "This build is missing its account configuration (\(key)). Reinstall Dash from a "
        + "complete build."
    case .invalidControlPlaneURL(let value):
      return "This build's Dash account service address isn't a valid URL (\(value)). Reinstall "
        + "Dash from a correctly configured build."
    case .placeholderControlPlaneURL:
      return "This build isn't pointed at a Dash account service yet, so signing in can't work. "
        + "If you built Dash yourself, set DASH_CONTROL_PLANE_URL in ios/Config/Local.xcconfig "
        + "and rebuild."
    }
  }
}
