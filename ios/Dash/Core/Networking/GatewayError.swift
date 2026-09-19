import Foundation

enum GatewayError: Error, Equatable, Sendable {
  case unauthorized
  case rateLimited(retryAfter: Duration?)
  case gatewayOffline
  case notFound
  case validation(String)
  case revisionConflict(current: ConversationSummaryDTO)
  case conversationBusy(activeTurnId: String)
  case capabilityRequired
  case updateRequired
  case transport(String)
  case mutationOutcomeUnknown(resourceID: String?, requestID: String?)
  case server(MobileAPIError, status: Int)
  /// A `/speech/*` failure carrying the provider-level `SpeechErrorCode`
  /// verbatim.
  ///
  /// Separate from `.server` because the status alone lies on this namespace:
  /// `httpStatusFor` in `@dash/speech` maps a provider's bad key to **401** and
  /// a provider outage to **502**, and `mapHTTPError` reads status before body
  /// — so without this, an expired OpenRouter credential told the user to
  /// re-pair the phone, and a provider outage on a relay profile read as
  /// "gateway offline". Neither is a connection problem, so a speech error
  /// must never reach `handleFeatureGatewayError`'s connection-state mapping.
  case speech(code: String, message: String, retryable: Bool)
}
