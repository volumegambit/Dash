package app.dash.connection

import java.net.URLEncoder
import kotlinx.serialization.Serializable

/**
 * Everything the app needs to reach one gateway: a host, two ports, and two
 * tokens. The connectivity transport (LAN, adb-reverse, or the future relay)
 * is invisible here — only [secure] changes when TLS is introduced.
 */
@Serializable
data class ConnectionProfile(
    val label: String,
    val host: String,
    val mgmtPort: Int = DEFAULT_MGMT_PORT,
    val chatPort: Int = DEFAULT_CHAT_PORT,
    val mgmtToken: String,
    val chatToken: String,
    /** When true, use https/wss (set by the relay later); LAN/adb use false. */
    val secure: Boolean = false,
) {
    val mgmtBaseUrl: String
        get() = "${if (secure) "https" else "http"}://$host:$mgmtPort"

    val chatWsUrl: String
        get() {
            val scheme = if (secure) "wss" else "ws"
            val token = URLEncoder.encode(chatToken, "UTF-8")
            return "$scheme://$host:$chatPort/ws?token=$token"
        }

    companion object {
        const val DEFAULT_MGMT_PORT = 9300
        const val DEFAULT_CHAT_PORT = 9200
    }
}
