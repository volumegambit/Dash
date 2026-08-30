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
  }

  private static let frontendAPIHostKey = "DashClerkFrontendAPI"
  private static let clientIDKey = "DashClerkClientID"
  private static let controlPlaneURLKey = "DashControlPlaneURL"
  private static let redirectURIValue = "dash://oauth-callback"

  /// Reads the three interpolated Info.plist keys from `bundle`.
  static func fromBundle(_ bundle: Bundle = .main) throws -> AccountAuthConfig {
    let frontendAPIHost = try requiredString(frontendAPIHostKey, in: bundle)
    let clientID = try requiredString(clientIDKey, in: bundle)
    let controlPlaneURLString = try requiredString(controlPlaneURLKey, in: bundle)
    guard let controlPlaneURL = URL(string: controlPlaneURLString) else {
      throw ConfigError.invalidControlPlaneURL(controlPlaneURLString)
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
