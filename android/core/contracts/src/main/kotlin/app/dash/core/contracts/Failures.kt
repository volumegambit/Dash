package app.dash.core.contracts

import java.time.Instant

sealed class GatewayFailure(message: String) : Exception(message) {
  data object Unauthorized : GatewayFailure("unauthorized")

  data object Forbidden : GatewayFailure("forbidden")

  data object NotFound : GatewayFailure("not found")

  data class Validation(val reason: String) : GatewayFailure("validation failed")

  data class RevisionConflict(val current: ConversationSummary) : GatewayFailure("revision conflict")

  data class ConversationBusy(val activeTurnId: String) : GatewayFailure("conversation busy")

  data object CapabilityRequired : GatewayFailure("capability required")

  data class UpdateRequired(val requiredApiVersion: Int = 1) : GatewayFailure("update required")

  data object GatewayOffline : GatewayFailure("gateway offline")

  data class RateLimited(val retryAt: Instant?) : GatewayFailure("rate limited")

  data class Transport(val operation: String) : GatewayFailure("transport failed")

  data class Decoding(val contract: String) : GatewayFailure("decoding failed")

  data class Storage(val operation: String) : GatewayFailure("storage failed")

  data class MutationOutcomeUnknown(val resourceId: String?, val requestId: String?) :
    GatewayFailure("mutation outcome unknown")
}
