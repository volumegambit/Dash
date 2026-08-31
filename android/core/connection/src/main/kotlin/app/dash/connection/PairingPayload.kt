package app.dash.connection

import app.dash.model.DashJson
import kotlinx.serialization.Serializable

/**
 * Parses a pairing payload — the JSON encoded in Mission Control's "Pair device"
 * QR code, or pasted during manual entry — into a [ConnectionProfile].
 *
 * Supported wire shapes:
 *  - v2 (relay): {"v":2,"host":"<gatewayId>.<zone>","secure":true,
 *                 "mgmtToken":"...","chatToken":"...","relayCredential":"..."}
 *  - v3 (LAN):   {"v":3,"host":"...","secure":true,"mgmtPort":9400,
 *                 "chatPort":9400,"mgmtToken":"...","chatToken":"...",
 *                 "tlsCertificateSha256":"<lowercase-hex>"}
 * In v2 the gateway is reached over TLS on the standard port (443) at its relay
 * subdomain. V3 trusts only the exact leaf certificate fingerprint carried by
 * the trusted pairing code. Both versions carry the same phone capability in
 * mgmtToken and chatToken. Legacy cleartext v1 payloads are rejected.
 */
object PairingPayload {
    private val SUPPORTED_VERSIONS = setOf(2, 3)
    private val CONTRACT_HOST = Regex("^(?![A-Za-z][A-Za-z0-9+.-]*:)[^\\s/\\\\?#@%]+$")
    private const val RELAY_VERSION = 2
    private const val PINNED_LAN_VERSION = 3
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
        val tlsCertificateSha256: String? = null,
    )

    /** Returns a validated profile, or a failure with a human-readable reason. */
    fun parse(raw: String): Result<ConnectionProfile> = runCatching {
        val p = DashJson.instance.decodeFromString<Payload>(raw.trim())
        require(p.v in SUPPORTED_VERSIONS) { "Unsupported pairing version: ${p.v}" }
        require(isValidHost(p.host)) { "Invalid host" }
        val managementToken = p.mgmtToken.trim()
        val chatToken = p.chatToken.trim()
        require(managementToken.isNotEmpty()) { "Missing mgmtToken" }
        require(chatToken.isNotEmpty()) { "Missing chatToken" }
        require(managementToken == chatToken) {
            "Pairing tokens must use one mobile capability"
        }

        val isRelay = p.v == RELAY_VERSION
        val isPinnedLan = p.v == PINNED_LAN_VERSION
        if (isRelay) {
            require(p.secure == true) { "Relay pairing requires secure=true" }
            require(!p.relayCredential.isNullOrBlank()) { "Missing relayCredential for relay pairing" }
        }
        val certificateSha256 = if (isPinnedLan) {
            require(p.secure == true) { "Pinned LAN pairing requires secure=true" }
            val rawCertificateSha256 = p.tlsCertificateSha256.orEmpty()
            val normalized = TlsCertificatePin.normalize(rawCertificateSha256)
                ?: error("Invalid tlsCertificateSha256 for pinned LAN pairing")
            normalized
        } else {
            null
        }
        val managementPort = if (isRelay) {
            RELAY_PORT
        } else {
            requireNotNull(p.mgmtPort) { "Missing mgmtPort for pinned LAN pairing" }
                .also { require(it in 1..65_535) { "Invalid mgmtPort" } }
        }
        val chatPort = if (isRelay) {
            RELAY_PORT
        } else {
            requireNotNull(p.chatPort) { "Missing chatPort for pinned LAN pairing" }
                .also { require(it in 1..65_535) { "Invalid chatPort" } }
        }
        if (isPinnedLan) {
            require(managementPort == chatPort) { "Pinned LAN pairing requires one shared port" }
        }

        ConnectionProfile(
            label = p.label?.takeIf { it.isNotBlank() } ?: p.host,
            host = p.host,
            mgmtPort = managementPort,
            chatPort = chatPort,
            mgmtToken = managementToken,
            chatToken = managementToken,
            secure = true,
            tlsCertificateSha256 = certificateSha256,
            relayCredential = if (isRelay) p.relayCredential else null,
        )
    }

    fun isValidHost(value: String): Boolean = CONTRACT_HOST.matches(value)
}
