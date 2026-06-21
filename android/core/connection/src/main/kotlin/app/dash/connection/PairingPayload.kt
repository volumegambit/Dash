package app.dash.connection

import app.dash.model.DashJson
import kotlinx.serialization.Serializable

/**
 * Parses a pairing payload — the JSON encoded in Mission Control's "Pair device"
 * QR code, or pasted during manual entry — into a [ConnectionProfile].
 *
 * Two wire shapes:
 *  - v1 (LAN):   {"v":1,"host":"...","mgmtToken":"...","chatToken":"...",
 *                 "mgmtPort":9300,"chatPort":9200,"label":"...","secure":false}
 *  - v2 (relay): {"v":2,"host":"<gatewayId>.<zone>","secure":true,
 *                 "mgmtToken":"...","chatToken":"...","relayCredential":"..."}
 * In v2 the gateway is reached over TLS on the standard port (443) at its relay
 * subdomain, and the relay credential authorizes this device.
 */
object PairingPayload {
    private val SUPPORTED_VERSIONS = setOf(1, 2)
    private const val RELAY_VERSION = 2
    private const val RELAY_PORT = 443

    @Serializable
    private data class Payload(
        val v: Int,
        val host: String,
        val mgmtToken: String,
        val chatToken: String,
        val mgmtPort: Int? = null,
        val chatPort: Int? = null,
        val label: String? = null,
        val secure: Boolean? = null,
        val relayCredential: String? = null,
    )

    /** Returns a validated profile, or a failure with a human-readable reason. */
    fun parse(raw: String): Result<ConnectionProfile> = runCatching {
        val p = DashJson.instance.decodeFromString<Payload>(raw.trim())
        require(p.v in SUPPORTED_VERSIONS) { "Unsupported pairing version: ${p.v}" }
        require(p.host.isNotBlank()) { "Missing host" }
        require(p.mgmtToken.isNotBlank()) { "Missing mgmtToken" }
        require(p.chatToken.isNotBlank()) { "Missing chatToken" }

        val isRelay = p.v == RELAY_VERSION
        if (isRelay) {
            require(!p.relayCredential.isNullOrBlank()) { "Missing relayCredential for relay pairing" }
        }

        ConnectionProfile(
            label = p.label?.takeIf { it.isNotBlank() } ?: p.host,
            host = p.host,
            // Relay reaches the gateway over TLS on 443 at its subdomain; LAN uses
            // the explicit ports (defaulting to the gateway's 9300/9200).
            mgmtPort = p.mgmtPort ?: if (isRelay) RELAY_PORT else ConnectionProfile.DEFAULT_MGMT_PORT,
            chatPort = p.chatPort ?: if (isRelay) RELAY_PORT else ConnectionProfile.DEFAULT_CHAT_PORT,
            mgmtToken = p.mgmtToken,
            chatToken = p.chatToken,
            // Relay is always TLS; LAN honors the flag (default false).
            secure = if (isRelay) true else (p.secure ?: false),
            relayCredential = if (isRelay) p.relayCredential else null,
        )
    }
}
