package app.dash.connection

import kotlinx.serialization.Serializable

/**
 * Everything the app needs to reach one gateway: a host, two ports, one phone
 * capability represented by the frozen token fields, and (for direct LAN TLS)
 * the exact leaf-certificate digest pinned at pairing.
 */
@Serializable
data class ConnectionProfile(
    val label: String,
    val host: String,
    val mgmtPort: Int = DEFAULT_MGMT_PORT,
    val chatPort: Int = DEFAULT_CHAT_PORT,
    val mgmtToken: String,
    val chatToken: String,
    /** When true, use https/wss. Relay uses public PKI; v3 LAN uses [tlsCertificateSha256]. */
    val secure: Boolean = true,
    /** Lowercase 64-character SHA-256 hex of the exact DER leaf certificate for v3 LAN. */
    val tlsCertificateSha256: String? = null,
    /**
     * Per-device relay credential, set only for relay (v2) pairing; null for
     * pinned LAN. Sent as the `x-dash-relay-credential` header so the relay admits
     * this device. A secret — stored encrypted, never shown.
     */
    val relayCredential: String? = null,
) {
    init {
        require(tlsCertificateSha256 == null || TlsCertificatePin.isCanonical(tlsCertificateSha256)) {
            "tlsCertificateSha256 must be canonical lowercase SHA-256 hex"
        }
        require(tlsCertificateSha256 == null || secure) {
            "A pinned certificate requires secure transport"
        }
    }

    val mgmtBaseUrl: String
        get() = "${if (secure) "https" else "http"}://$host:$mgmtPort"

    val chatWsUrl: String
        get() {
            val scheme = if (secure) "wss" else "ws"
            return "$scheme://$host:$chatPort/ws/chat"
        }

    /** Legacy plaintext or split-token profiles must re-pair before any networking begins. */
    val requiresRepair: Boolean
        get() =
            !secure ||
                mgmtToken != chatToken ||
                (tlsCertificateSha256 == null && relayCredential == null)

    companion object {
        const val DEFAULT_MGMT_PORT = 9300
        const val DEFAULT_CHAT_PORT = 9200
        const val DEFAULT_PINNED_LAN_PORT = 9400
    }
}
