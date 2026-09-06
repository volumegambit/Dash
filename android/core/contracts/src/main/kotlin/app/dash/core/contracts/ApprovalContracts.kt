package app.dash.core.contracts

@JvmInline
value class ApprovalId(val value: String)

@JvmInline
value class PairingId(val value: String)

@JvmInline
value class SignerId(val value: String)

enum class ApprovalDecision(val wireValue: String) {
  Approve("approve"),
  Deny("deny"),
}

data class SignerPublicIdentity(val publicKeyBase64Url: String)

data class ApprovalRequest(
  val approvalId: ApprovalId,
  val pairingId: PairingId,
  val gatewayId: String,
  val deviceLabel: String?,
  val expiresAtEpochMillis: Long,
)
