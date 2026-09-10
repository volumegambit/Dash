package app.dash.network

import app.dash.model.DashJson
import app.dash.model.GatewayIdentity
import app.dash.model.MobileApiError
import app.dash.model.MobileApiErrorCode
import app.dash.model.MobileV2ActionResponse
import app.dash.model.MobileV2Agent
import app.dash.model.MobileV2HealthResponse
import app.dash.model.MobileV2Json
import app.dash.model.RegisteredAgent
import java.io.IOException
import java.net.URLEncoder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import kotlin.coroutines.resumeWithException

sealed interface GatewayProtocolSelection {
    data object V1 : GatewayProtocolSelection

    data class V2(
        val gatewayId: String,
        val capabilities: Set<String>,
    ) : GatewayProtocolSelection {
        init {
            require(gatewayId.isNotEmpty())
            require(REQUIRED_V2_CAPABILITY in capabilities)
        }
    }
}

sealed interface GatewayNegotiation {
    data class V2(val gatewayId: String, val capabilities: Set<String>) : GatewayNegotiation {
        init {
            require(gatewayId.isNotEmpty())
        }

        fun selection(): GatewayProtocolSelection.V2 =
            GatewayProtocolSelection.V2(gatewayId, capabilities)
    }

    data object UnsupportedVersion : GatewayNegotiation

    sealed interface Failed : GatewayNegotiation {
        data class Authentication(val status: Int, val message: String) : Failed
        data class Malformed(val message: String) : Failed
        data class Api(val status: Int, val error: MobileApiError) : Failed
        data class Transport(val cause: IOException) : Failed
    }
}

sealed interface GatewaySessionSelection {
    data class Selected(val value: GatewayProtocolSelection) : GatewaySessionSelection
    data class Failed(val message: String) : GatewaySessionSelection
}

/** Validates a fresh negotiation against the protocol and identity persisted at pairing. */
fun selectGatewaySession(
    expectedGatewayId: String?,
    negotiation: GatewayNegotiation,
): GatewaySessionSelection = when (negotiation) {
    is GatewayNegotiation.V2 -> when {
        expectedGatewayId == null -> GatewaySessionSelection.Failed(
            "Gateway protocol changed from mobile v1 to mobile v2; pair again",
        )
        REQUIRED_V2_CAPABILITY !in negotiation.capabilities -> GatewaySessionSelection.Failed(
            "Mobile API v2 omitted required capability $REQUIRED_V2_CAPABILITY",
        )
        negotiation.gatewayId != expectedGatewayId -> GatewaySessionSelection.Failed(
            "Gateway identity changed; pair again",
        )
        else -> GatewaySessionSelection.Selected(negotiation.selection())
    }
    GatewayNegotiation.UnsupportedVersion -> if (expectedGatewayId == null) {
        GatewaySessionSelection.Selected(GatewayProtocolSelection.V1)
    } else {
        GatewaySessionSelection.Failed(
            "Gateway protocol changed from mobile v2 to mobile v1; pair again",
        )
    }
    is GatewayNegotiation.Failed.Authentication -> GatewaySessionSelection.Failed(
        "Gateway authentication failed (HTTP ${negotiation.status})",
    )
    is GatewayNegotiation.Failed.Malformed -> GatewaySessionSelection.Failed(negotiation.message)
    is GatewayNegotiation.Failed.Api -> GatewaySessionSelection.Failed(negotiation.error.error)
    is GatewayNegotiation.Failed.Transport -> GatewaySessionSelection.Failed(
        negotiation.cause.message ?: "Could not reach gateway",
    )
}

/**
 * Gateway REST client with an immutable protocol selection. Only [forNegotiation] retains an
 * unversioned origin; every ordinary request is constructed by [selected] with an explicit v1 or
 * verified v2 selection.
 */
class GatewayClient private constructor(
    baseUrl: String,
    private val mgmtToken: String,
    private val client: OkHttpClient,
    private val relayCredential: String?,
    val protocolSelection: GatewayProtocolSelection?,
) {
    private val origin = baseUrl.trimEnd('/')
    private val json = DashJson.instance
    private val v2Json = MobileV2Json.instance
    private val selectedBase: String?
        get() = protocolSelection?.let {
            "$origin/mobile/${if (it is GatewayProtocolSelection.V2) "v2" else "v1"}"
        }

    suspend fun negotiate(): GatewayNegotiation {
        check(protocolSelection == null) { "A selected gateway client cannot renegotiate" }
        return try {
            executeAbsolute("/mobile/v2/health").use { response ->
                val body = response.body?.string().orEmpty()
                when {
                    response.code == 404 -> GatewayNegotiation.UnsupportedVersion
                    response.code == 401 || response.code == 403 ->
                        GatewayNegotiation.Failed.Authentication(response.code, body)
                    !response.isSuccessful -> negotiateHttpFailure(response.code, body)
                    else -> negotiateFromHealth(body)
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: IOException) {
            GatewayNegotiation.Failed.Transport(error)
        } catch (error: Exception) {
            GatewayNegotiation.Failed.Malformed(
                error.message ?: "Malformed mobile v2 negotiation response",
            )
        }
    }

    suspend fun health(): Boolean {
        requireSelected()
        return try {
            execute(get("/health")).use { it.isSuccessful }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            false
        }
    }

    suspend fun listAgents(): List<RegisteredAgent> {
        requireSelected()
        return execute(get("/agents")).use { response ->
            val body = bodyOrThrow(response)
            when (protocolSelection) {
                is GatewayProtocolSelection.V2 ->
                    decodeV2AgentList(body).map { it.toRegisteredAgent() }
                GatewayProtocolSelection.V1 ->
                    json.decodeFromString(ListSerializer(RegisteredAgent.serializer()), body)
                null -> error("Gateway protocol selection is required")
            }
        }
    }

    suspend fun getAgent(id: String): RegisteredAgent {
        requireSelected()
        return execute(get("/agents/${id.enc()}")).use { response ->
            val body = bodyOrThrow(response)
            when (protocolSelection) {
                is GatewayProtocolSelection.V2 -> decodeV2Agent(body).toRegisteredAgent()
                GatewayProtocolSelection.V1 -> json.decodeFromString(RegisteredAgent.serializer(), body)
                null -> error("Gateway protocol selection is required")
            }
        }
    }

    suspend fun enable(id: String): Unit = post("/agents/${id.enc()}/enable")

    suspend fun disable(id: String): Unit = post("/agents/${id.enc()}/disable")

    private suspend fun negotiateFromHealth(body: String): GatewayNegotiation {
        val health = try {
            v2Json.decodeFromString(MobileV2HealthResponse.serializer(), body)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            return GatewayNegotiation.Failed.Malformed(
                error.message ?: "Malformed mobile v2 health response",
            )
        }

        val identity = try {
            getV2Identity()
        } catch (error: CancellationException) {
            throw error
        } catch (error: GatewayHttpError.Unauthorized) {
            return GatewayNegotiation.Failed.Authentication(error.status, error.bodyText)
        } catch (error: GatewayHttpError.Structured) {
            return GatewayNegotiation.Failed.Api(error.status, error.error)
        } catch (error: IOException) {
            return GatewayNegotiation.Failed.Transport(error)
        } catch (error: Exception) {
            return GatewayNegotiation.Failed.Malformed(
                error.message ?: "Malformed mobile v2 identity response",
            )
        }

        return if (REQUIRED_V2_CAPABILITY !in health.capabilities) {
            GatewayNegotiation.Failed.Malformed(
                "Mobile API v2 omitted required capability $REQUIRED_V2_CAPABILITY",
            )
        } else {
            GatewayNegotiation.V2(identity.gatewayId, health.capabilities.toSet())
        }
    }

    private fun negotiateHttpFailure(status: Int, body: String): GatewayNegotiation {
        val error = decodeStrictMobileApiError(body)
            ?: return GatewayNegotiation.Failed.Malformed(
                "HTTP $status did not contain an exact MobileApiError",
            )
        return if (status == 426 && error.code == MobileApiErrorCode.CAPABILITY_REQUIRED) {
            GatewayNegotiation.UnsupportedVersion
        } else {
            GatewayNegotiation.Failed.Api(status, error)
        }
    }

    private suspend fun getV2Identity(): GatewayIdentity =
        executeAbsolute("/mobile/v2/identity").use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw responseError(response.code, body)
            decodeExactGatewayIdentity(body)
                ?: throw IllegalArgumentException("Malformed mobile v2 identity response")
        }

    private suspend fun post(path: String) {
        requireSelected()
        val request = authedSelected(path).post(ByteArray(0).toRequestBody(null)).build()
        execute(request).use { response ->
            val body = bodyOrThrow(response)
            if (protocolSelection is GatewayProtocolSelection.V2) {
                decodeStrictMobileV2ActionResponse(body)
                    ?: throw SerializationException(
                        "Malformed mobile v2 action acknowledgement",
                    )
            }
        }
    }

    private fun get(path: String): Request = authedSelected(path).get().build()

    private fun authedSelected(path: String): Request.Builder {
        val base = requireNotNull(selectedBase) { "Gateway protocol selection is required" }
        requireRelativePath(path)
        return authedUrl(base + path)
    }

    private fun authedAbsolute(path: String): Request.Builder {
        require(path.startsWith('/') && !path.startsWith("//"))
        return authedUrl(origin + path)
    }

    private fun authedUrl(url: String): Request.Builder =
        Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $mgmtToken")
            .apply { relayCredential?.let { header(RELAY_CREDENTIAL_HEADER, it) } }

    private suspend fun executeAbsolute(path: String): Response =
        execute(authedAbsolute(path).get().build())

    @OptIn(ExperimentalCoroutinesApi::class)
    private suspend fun execute(request: Request): Response =
        suspendCancellableCoroutine { continuation ->
            val call = client.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            try {
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        if (!continuation.isActive) return
                        val cancellation = e.findCancellationCause()
                        continuation.resumeWithException(cancellation ?: e)
                    }

                    override fun onResponse(call: Call, response: Response) {
                        if (!continuation.isActive) {
                            response.close()
                            return
                        }
                        continuation.resume(response) { response.close() }
                    }
                })
            } catch (error: Throwable) {
                if (continuation.isActive) continuation.resumeWithException(error)
            }
        }

    private fun bodyOrThrow(response: Response): String {
        val body = response.body?.string().orEmpty()
        if (!response.isSuccessful) throw responseError(response.code, body)
        return body
    }

    private fun responseError(status: Int, body: String): GatewayHttpError = when (status) {
        401, 403 -> GatewayHttpError.Unauthorized(status, body)
        else -> decodeStrictMobileApiError(body)?.let {
            GatewayHttpError.Structured(status, body, it)
        } ?: GatewayHttpError(status, body)
    }

    private fun requireSelected() {
        check(protocolSelection != null) { "Gateway protocol selection is required" }
    }

    private fun requireRelativePath(path: String) {
        require(path.startsWith('/') && !path.startsWith("//"))
    }

    private fun String.enc(): String = URLEncoder.encode(this, Charsets.UTF_8.name())

    companion object {
        /** Header the relay reads to authorize a paired device. */
        const val RELAY_CREDENTIAL_HEADER = "x-dash-relay-credential"

        fun forNegotiation(
            baseUrl: String,
            mgmtToken: String,
            client: OkHttpClient = OkHttpClient(),
            relayCredential: String? = null,
        ): GatewayClient = GatewayClient(baseUrl, mgmtToken, client, relayCredential, null)

        fun selected(
            baseUrl: String,
            mgmtToken: String,
            selection: GatewayProtocolSelection,
            client: OkHttpClient = OkHttpClient(),
            relayCredential: String? = null,
        ): GatewayClient = GatewayClient(baseUrl, mgmtToken, client, relayCredential, selection)
    }
}

private const val REQUIRED_V2_CAPABILITY = "chat-input-queue-v1"

fun decodeStrictMobileApiError(body: String): MobileApiError? {
    val json = MobileV2Json.instance
    val value = runCatching { json.parseToJsonElement(body) }.getOrNull() as? JsonObject ?: return null
    val allowed = setOf("code", "error", "retryable", "details")
    if (value.keys !in setOf(setOf("code", "error", "retryable"), allowed)) return null
    val code = value["code"].strictString() ?: return null
    if (code !in MOBILE_API_ERROR_CODES) return null
    val error = value["error"].strictString()?.takeIf { it.isNotBlank() } ?: return null
    if (value["retryable"].strictBoolean() == null) return null
    if ("details" in value && value["details"] !is JsonObject) return null
    return runCatching { json.decodeFromJsonElement(MobileApiError.serializer(), value) }.getOrNull()
        ?.takeIf { it.error == error }
}

fun decodeExactGatewayIdentity(body: String): GatewayIdentity? {
    val json = MobileV2Json.instance
    val value = runCatching { json.parseToJsonElement(body) }.getOrNull() as? JsonObject ?: return null
    if (value.keys != setOf("gatewayId", "publicKey")) return null
    val gatewayId = value["gatewayId"].strictString()?.takeIf { it.isNotEmpty() } ?: return null
    val publicKey = value["publicKey"].strictString()?.takeIf { it.isNotEmpty() } ?: return null
    return runCatching { GatewayIdentity(gatewayId, publicKey) }.getOrNull()
}

fun decodeStrictMobileV2ActionResponse(body: String): MobileV2ActionResponse? {
    val value = runCatching { MobileV2Json.instance.parseToJsonElement(body) }.getOrNull()
        as? JsonObject ?: return null
    if (value.keys != setOf("ok") || value["ok"].strictBoolean() != true) return null
    return MobileV2ActionResponse(ok = true)
}

private fun JsonElement?.strictString(): String? =
    (this as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonElement?.strictBoolean(): Boolean? =
    (this as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull

private fun IOException.findCancellationCause(): CancellationException? {
    var current: Throwable? = this
    val seen = mutableSetOf<Throwable>()
    while (current != null && seen.add(current)) {
        if (current is CancellationException) return current
        current = current.cause ?: current.suppressed.firstOrNull()
    }
    return null
}

private val MOBILE_API_ERROR_CODES = setOf(
    "unauthorized",
    "not_found",
    "validation_failed",
    "revision_conflict",
    "conversation_busy",
    "rate_limited",
    "gateway_offline",
    "capability_required",
)

private fun decodeV2AgentList(body: String): List<MobileV2Agent> {
    val json = MobileV2Json.instance
    val array = runCatching { json.parseToJsonElement(body) }.getOrElse {
        throw SerializationException("Malformed mobile v2 agent list", it)
    } as? JsonArray ?: throw SerializationException("Mobile v2 agent list must be an array")
    return array.map { decodeV2AgentElement(it) }
}

private fun decodeV2Agent(body: String): MobileV2Agent {
    val json = MobileV2Json.instance
    val element = runCatching { json.parseToJsonElement(body) }.getOrElse {
        throw SerializationException("Malformed mobile v2 agent", it)
    }
    return decodeV2AgentElement(element)
}

private fun decodeV2AgentElement(element: JsonElement): MobileV2Agent {
    val value = element as? JsonObject
        ?: throw SerializationException("Mobile v2 agent must be an object")
    requireExactKeys(value, setOf("id", "name", "config", "status", "registeredAt"))
    val config = value["config"] as? JsonObject
        ?: throw SerializationException("Mobile v2 agent config must be an object")
    requireRequiredAllowedKeys(
        config,
        required = setOf("name", "model", "systemPrompt"),
        allowed = setOf(
            "name", "model", "systemPrompt", "fallbackModels", "tools", "skills", "workspace",
            "maxTokens", "mcpServers", "plugins", "providers", "swarm",
        ),
    )
    (config["skills"] as? JsonObject)?.let {
        requireRequiredAllowedKeys(it, emptySet(), setOf("paths", "urls"))
    }
    (config["swarm"] as? JsonObject)?.let {
        requireRequiredAllowedKeys(
            it,
            emptySet(),
            setOf(
                "enabled", "maxConcurrentWorkers", "maxWorkersPerRun", "maxSteersPerWorker",
                "maxRunSeconds", "allowedModels",
            ),
        )
    }
    rejectExplicitNulls(value)
    return MobileV2Json.instance.decodeFromJsonElement(MobileV2Agent.serializer(), value)
}

private fun requireExactKeys(value: JsonObject, expected: Set<String>) {
    if (value.keys != expected) throw SerializationException("Unexpected mobile v2 object keys")
}

private fun requireRequiredAllowedKeys(
    value: JsonObject,
    required: Set<String>,
    allowed: Set<String>,
) {
    if (!value.keys.containsAll(required) || !allowed.containsAll(value.keys)) {
        throw SerializationException("Unexpected mobile v2 object keys")
    }
}

private fun rejectExplicitNulls(value: JsonElement) {
    when (value) {
        JsonNull -> throw SerializationException("Explicit null is not allowed in mobile v2")
        is JsonObject -> value.values.forEach(::rejectExplicitNulls)
        is JsonArray -> value.forEach(::rejectExplicitNulls)
        else -> Unit
    }
}
