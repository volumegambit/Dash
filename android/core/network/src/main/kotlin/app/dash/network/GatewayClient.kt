package app.dash.network

import app.dash.model.DashJson
import app.dash.model.RegisteredAgent
import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * Talks to the gateway HTTP management API (default port 9300).
 *
 * Endpoints: apps/gateway/src/management-api.ts. All calls send
 * `Authorization: Bearer <mgmtToken>`; non-2xx responses throw [GatewayHttpError].
 */
class GatewayClient(
    baseUrl: String,
    private val mgmtToken: String,
    private val client: OkHttpClient = OkHttpClient(),
    /** Per-device relay credential; when set, sent on every request so the relay
     *  admits this device. Null for LAN/adb connections. */
    private val relayCredential: String? = null,
) {
    private val base = baseUrl.trimEnd('/')
    private val json = DashJson.instance

    suspend fun health(): Boolean = withContext(Dispatchers.IO) {
        try {
            client.newCall(get("/health")).execute().use { it.isSuccessful }
        } catch (_: Exception) {
            false
        }
    }

    suspend fun listAgents(): List<RegisteredAgent> = withContext(Dispatchers.IO) {
        client.newCall(get("/agents")).execute().use { resp ->
            json.decodeFromString(ListSerializer(RegisteredAgent.serializer()), bodyOrThrow(resp))
        }
    }

    suspend fun getAgent(id: String): RegisteredAgent = withContext(Dispatchers.IO) {
        client.newCall(get("/agents/${id.enc()}")).execute().use { resp ->
            json.decodeFromString(RegisteredAgent.serializer(), bodyOrThrow(resp))
        }
    }

    suspend fun enable(id: String): Unit = post("/agents/${id.enc()}/enable")

    suspend fun disable(id: String): Unit = post("/agents/${id.enc()}/disable")

    private suspend fun post(path: String): Unit = withContext(Dispatchers.IO) {
        val req = authed(path).post(ByteArray(0).toRequestBody(null)).build()
        client.newCall(req).execute().use { resp -> bodyOrThrow(resp) }
        Unit
    }

    private fun get(path: String): Request = authed(path).get().build()

    /** A request builder with the gateway Bearer and, when relayed, the relay credential. */
    private fun authed(path: String): Request.Builder {
        val b = Request.Builder().url(base + path).header("Authorization", "Bearer $mgmtToken")
        relayCredential?.let { b.header(RELAY_CREDENTIAL_HEADER, it) }
        return b
    }

    private fun bodyOrThrow(resp: Response): String {
        val text = resp.body?.string().orEmpty()
        if (!resp.isSuccessful) throw GatewayHttpError(resp.code, text)
        return text
    }

    private fun String.enc(): String = URLEncoder.encode(this, "UTF-8")

    companion object {
        /** Header the relay reads to authorize a paired device. */
        const val RELAY_CREDENTIAL_HEADER = "x-dash-relay-credential"
    }
}
