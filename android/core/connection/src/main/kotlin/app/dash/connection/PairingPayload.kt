package app.dash.connection

import app.dash.model.DashJson
import kotlinx.serialization.Serializable

/**
 * Parses a pairing payload — the JSON encoded in Mission Control's "Pair device"
 * QR code, or pasted during manual entry — into a [ConnectionProfile].
 *
 * Wire shape: {"v":1,"host":"...","mgmtToken":"...","chatToken":"...",
 *              "mgmtPort":9300,"chatPort":9200,"label":"...","secure":false}
 */
object PairingPayload {
    private const val SUPPORTED_VERSION = 1

    @Serializable
    private data class Payload(
        val v: Int,
        val host: String,
        val mgmtToken: String,
        val chatToken: String,
        val mgmtPort: Int = ConnectionProfile.DEFAULT_MGMT_PORT,
        val chatPort: Int = ConnectionProfile.DEFAULT_CHAT_PORT,
        val label: String? = null,
        val secure: Boolean = false,
    )

    /** Returns a validated profile, or a failure with a human-readable reason. */
    fun parse(raw: String): Result<ConnectionProfile> = runCatching {
        val p = DashJson.instance.decodeFromString<Payload>(raw.trim())
        require(p.v == SUPPORTED_VERSION) { "Unsupported pairing version: ${p.v}" }
        require(p.host.isNotBlank()) { "Missing host" }
        require(p.mgmtToken.isNotBlank()) { "Missing mgmtToken" }
        require(p.chatToken.isNotBlank()) { "Missing chatToken" }
        ConnectionProfile(
            label = p.label?.takeIf { it.isNotBlank() } ?: p.host,
            host = p.host,
            mgmtPort = p.mgmtPort,
            chatPort = p.chatPort,
            mgmtToken = p.mgmtToken,
            chatToken = p.chatToken,
            secure = p.secure,
        )
    }
}
