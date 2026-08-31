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
}
