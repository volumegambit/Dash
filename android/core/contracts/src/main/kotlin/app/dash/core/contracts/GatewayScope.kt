package app.dash.core.contracts

import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.Serializable

@Serializable
@JvmInline
value class AccountScope(val value: String) {
  init {
    require(value.isNotBlank())
  }

  companion object {
    fun fromClaims(issuer: String, organizationId: String): AccountScope {
      require(issuer.isNotBlank() && organizationId.isNotBlank())
      val input = "$issuer\n$organizationId".toByteArray(Charsets.UTF_8)
      val digest = MessageDigest.getInstance("SHA-256").digest(input)
      return AccountScope(Base64.getUrlEncoder().withoutPadding().encodeToString(digest))
    }
  }
}

@Serializable
data class GatewayScope(val accountScope: AccountScope, val gatewayId: String) {
  init {
    require(gatewayId.isNotBlank())
  }
}
