package app.dash.model

import java.util.Base64
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

internal object MobileV2ContractValidation {
    const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    private const val MAX_IMAGE_BYTES = 5 * 1_024 * 1_024
    private const val MAX_TOTAL_IMAGE_BYTES = 12 * 1_024 * 1_024
    const val MAX_ENCODED_IMAGE_CHARS = ((MAX_IMAGE_BYTES + 2) / 3) * 4
    private val uuidPattern = Regex(
        "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-" +
            "[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$",
    )
    private val rfc3339Pattern = Regex(
        "^(\\d{4})-(\\d{2})-(\\d{2})[Tt](\\d{2}):(\\d{2}):(\\d{2})" +
            "(?:\\.\\d+)?([Zz]|([+-])(\\d{2}):(\\d{2}))$",
    )
    private val imageMediaTypes = setOf("image/jpeg", "image/png", "image/gif", "image/webp")

    fun requireCanonicalUuid(value: String, field: String) {
        require(uuidPattern.matches(value)) { "$field must be a canonical UUID" }
    }

    fun requireLegacyRunId(value: String, field: String) {
        val bytes = value.toByteArray(Charsets.UTF_8)
        require(bytes.size in 1..256 && bytes.any { it !in LEGACY_ASCII_WHITESPACE }) {
            "$field must be a nonblank legacy run ID of at most 256 UTF-8 bytes"
        }
    }

    fun requireNonEmpty(value: String, field: String) {
        require(value.codePointCount(0, value.length) >= 1) { "$field must not be empty" }
    }

    fun requireCodePointLength(value: String, min: Int, max: Int, field: String) {
        val count = value.codePointCount(0, value.length)
        require(count in min..max) { "$field must contain $min..$max Unicode code points" }
    }

    fun requireSafeInteger(value: Long, minimum: Long = 0, field: String) {
        require(value in minimum..MAX_SAFE_INTEGER) { "$field is outside the safe-integer range" }
    }

    fun requireCapabilities(values: List<String>, field: String) {
        values.forEachIndexed { index, value -> requireNonEmpty(value, "$field[$index]") }
        require(values.distinct().size == values.size) { "$field must not contain duplicates" }
    }

    fun requireRfc3339(value: String, field: String) {
        val match = rfc3339Pattern.matchEntire(value)
            ?: throw IllegalArgumentException("$field must be an RFC 3339 timestamp")
        val year = match.groupValues[1].toInt()
        val month = match.groupValues[2].toInt()
        val day = match.groupValues[3].toInt()
        val hour = match.groupValues[4].toInt()
        val minute = match.groupValues[5].toInt()
        val second = match.groupValues[6].toInt()
        require(month in 1..12) { "$field has an invalid month" }
        require(day in 1..daysInMonth(year, month)) { "$field has an invalid calendar day" }
        require(hour in 0..23 && minute in 0..59 && second in 0..60) {
            "$field has an invalid clock time"
        }

        var offsetMinutes = 0
        if (match.groupValues[7] != "Z" && match.groupValues[7] != "z") {
            val offsetHour = match.groupValues[9].toInt()
            val offsetMinute = match.groupValues[10].toInt()
            require(offsetHour in 0..23 && offsetMinute in 0..59) {
                "$field has an invalid UTC offset"
            }
            offsetMinutes = offsetHour * 60 + offsetMinute
            if (match.groupValues[8] == "-") offsetMinutes = -offsetMinutes
        }
        if (second == 60) {
            val utcMinuteOfDay = Math.floorMod(hour * 60 + minute - offsetMinutes, 24 * 60)
            require(utcMinuteOfDay == 23 * 60 + 59) {
                "$field places a leap second outside 23:59 UTC"
            }
        }
    }

    fun requireImages(images: List<WsMessageImage>?, field: String) {
        if (images == null) return
        require(images.size <= 4) { "$field must contain at most four images" }
        val decodedSizes = images.mapIndexed { index, image ->
            preflightImage(image, "$field[$index]")
        }
        require(decodedSizes.sumOf(Int::toLong) <= MAX_TOTAL_IMAGE_BYTES) {
            "$field exceeds 12 MiB"
        }
        images.forEachIndexed { index, image -> validateImage(image, "$field[$index]") }
    }

    fun preflightImage(image: WsMessageImage, field: String): Int {
        require(image.mediaType in imageMediaTypes) { "$field.mediaType is unsupported" }
        requireNonEmpty(image.data, "$field.data")
        require(image.data.length <= MAX_ENCODED_IMAGE_CHARS) {
            "$field.data exceeds the encoded 5 MiB limit"
        }
        require(image.data.length % 4 == 0) { "$field.data must be canonical base64" }

        val padding = when {
            image.data.endsWith("==") -> 2
            image.data.endsWith('=') -> 1
            else -> 0
        }
        val unpaddedLength = image.data.length - padding
        require(unpaddedLength > 0) { "$field.data must be canonical base64" }
        image.data.forEachIndexed { index, character ->
            require(
                if (index < unpaddedLength) base64Value(character) >= 0 else character == '=',
            ) {
                "$field.data must be canonical base64"
            }
        }
        when (padding) {
            2 -> require(base64Value(image.data[unpaddedLength - 1]) and 0x0F == 0) {
                "$field.data must be canonical base64"
            }
            1 -> require(base64Value(image.data[unpaddedLength - 1]) and 0x03 == 0) {
                "$field.data must be canonical base64"
            }
        }

        val decodedSize = image.data.length / 4 * 3 - padding
        require(decodedSize <= MAX_IMAGE_BYTES) { "$field exceeds 5 MiB" }
        return decodedSize
    }

    fun validateImage(
        image: WsMessageImage,
        field: String,
        decodeBase64: (String) -> ByteArray = { Base64.getDecoder().decode(it) },
    ): ByteArray {
        val expectedSize = preflightImage(image, field)
        val decoded = runCatching { decodeBase64(image.data) }
            .getOrElse { throw IllegalArgumentException("$field.data must be canonical base64", it) }
        require(decoded.size == expectedSize) {
            "$field.data decoded to an unexpected size"
        }
        return decoded
    }

    private fun base64Value(character: Char): Int = when (character) {
        in 'A'..'Z' -> character - 'A'
        in 'a'..'z' -> character - 'a' + 26
        in '0'..'9' -> character - '0' + 52
        '+' -> 62
        '/' -> 63
        else -> -1
    }

    private fun daysInMonth(year: Int, month: Int): Int = when (month) {
        2 -> if (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) 29 else 28
        4, 6, 9, 11 -> 30
        else -> 31
    }

    private val LEGACY_ASCII_WHITESPACE = byteArrayOf(0x20, 0x09, 0x0D, 0x0A)
}

object MobileV2StrictImageSerializer : KSerializer<WsMessageImage> {
    override val descriptor: SerialDescriptor = WsMessageImage.serializer().descriptor

    override fun deserialize(decoder: Decoder): WsMessageImage {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("Mobile v2 images require JSON")
        val objectValue = input.decodeJsonElement() as? JsonObject
            ?: throw SerializationException("Mobile v2 image must be an object")
        require(objectValue.keys == setOf("mediaType", "data")) {
            "Mobile v2 image must contain exactly mediaType and data"
        }
        val mediaType = objectValue.requiredString("mediaType")
        val data = objectValue.requiredString("data")
        return WsMessageImage(mediaType, data).also {
            MobileV2ContractValidation.preflightImage(it, "image")
        }
    }

    override fun serialize(encoder: Encoder, value: WsMessageImage) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("Mobile v2 images require JSON")
        MobileV2ContractValidation.validateImage(value, "image")
        output.encodeJsonElement(
            buildJsonObject {
                put("mediaType", value.mediaType)
                put("data", value.data)
            },
        )
    }
}

data class MobileV2UnknownAgentEvent(
    val eventType: String,
    val raw: JsonObject,
) : AgentEvent

data class MobileV2TypedAgentEvent(
    val value: AgentEvent,
    val raw: JsonObject,
) : AgentEvent

object MobileV2StrictAgentEventSerializer : KSerializer<AgentEvent> {
    override val descriptor: SerialDescriptor = JsonObject.serializer().descriptor

    override fun deserialize(decoder: Decoder): AgentEvent {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("Mobile v2 events require JSON")
        val raw = input.decodeJsonElement() as? JsonObject
            ?: throw SerializationException("Mobile v2 event must be an object")
        val type = raw.requiredString("type")
        MobileV2ContractValidation.requireNonEmpty(type, "event.type")
        val mapped = runCatching {
            DashJson.instance.decodeFromJsonElement(AgentEvent.serializer(), raw)
        }.getOrNull()
        return if (mapped == null || mapped is AgentEvent.Unknown) {
            MobileV2UnknownAgentEvent(type, raw)
        } else {
            MobileV2TypedAgentEvent(mapped, raw)
        }
    }

    override fun serialize(encoder: Encoder, value: AgentEvent) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("Mobile v2 events require JSON")
        val raw = when (value) {
            is MobileV2UnknownAgentEvent -> value.raw
            is MobileV2TypedAgentEvent -> value.raw
            else -> encodeKnownAgentEvent(value)
        }
        val type = raw.requiredString("type")
        MobileV2ContractValidation.requireNonEmpty(type, "event.type")
        output.encodeJsonElement(raw)
    }
}

private fun encodeKnownAgentEvent(value: AgentEvent): JsonObject {
    val (type, payload) = when (value) {
        is AgentEvent.TextDelta ->
            "text_delta" to DashJson.instance.encodeToJsonElement(
                AgentEvent.TextDelta.serializer(),
                value,
            ).jsonObject
        is AgentEvent.ThinkingDelta ->
            "thinking_delta" to DashJson.instance.encodeToJsonElement(
                AgentEvent.ThinkingDelta.serializer(),
                value,
            ).jsonObject
        is AgentEvent.ToolUseStart ->
            "tool_use_start" to DashJson.instance.encodeToJsonElement(
                AgentEvent.ToolUseStart.serializer(),
                value,
            ).jsonObject
        is AgentEvent.ToolUseDelta ->
            "tool_use_delta" to DashJson.instance.encodeToJsonElement(
                AgentEvent.ToolUseDelta.serializer(),
                value,
            ).jsonObject
        is AgentEvent.ToolResult ->
            "tool_result" to DashJson.instance.encodeToJsonElement(
                AgentEvent.ToolResult.serializer(),
                value,
            ).jsonObject
        is AgentEvent.Response ->
            "response" to DashJson.instance.encodeToJsonElement(
                AgentEvent.Response.serializer(),
                value,
            ).jsonObject
        is AgentEvent.ErrorEvent ->
            "error" to DashJson.instance.encodeToJsonElement(
                AgentEvent.ErrorEvent.serializer(),
                value,
            ).jsonObject
        is AgentEvent.FileChanged ->
            "file_changed" to DashJson.instance.encodeToJsonElement(
                AgentEvent.FileChanged.serializer(),
                value,
            ).jsonObject
        is AgentEvent.AgentSpawned ->
            "agent_spawned" to DashJson.instance.encodeToJsonElement(
                AgentEvent.AgentSpawned.serializer(),
                value,
            ).jsonObject
        is AgentEvent.AgentRetry ->
            "agent_retry" to DashJson.instance.encodeToJsonElement(
                AgentEvent.AgentRetry.serializer(),
                value,
            ).jsonObject
        is AgentEvent.ContextCompacted ->
            "context_compacted" to DashJson.instance.encodeToJsonElement(
                AgentEvent.ContextCompacted.serializer(),
                value,
            ).jsonObject
        is AgentEvent.Question ->
            "question" to DashJson.instance.encodeToJsonElement(
                AgentEvent.Question.serializer(),
                value,
            ).jsonObject
        is AgentEvent.SkillLoaded ->
            "skill_loaded" to DashJson.instance.encodeToJsonElement(
                AgentEvent.SkillLoaded.serializer(),
                value,
            ).jsonObject
        is AgentEvent.SkillCreated ->
            "skill_created" to DashJson.instance.encodeToJsonElement(
                AgentEvent.SkillCreated.serializer(),
                value,
            ).jsonObject
        is AgentEvent.McpServerError ->
            "mcp_server_error" to DashJson.instance.encodeToJsonElement(
                AgentEvent.McpServerError.serializer(),
                value,
            ).jsonObject
        is AgentEvent.Unknown -> "unknown" to buildJsonObject { put("type", value.type) }
        is MobileV2UnknownAgentEvent -> return value.raw
        is MobileV2TypedAgentEvent -> return value.raw
    }
    return buildJsonObject {
        put("type", type)
        payload.forEach { (key, element) -> put(key, element) }
    }
}

@Serializable
data class MobileV2HealthResponse(
    val status: String,
    val startedAt: String,
    val pid: Int,
    val agents: Int,
    val channels: Int,
    val apiVersion: Int,
    val capabilities: List<String>,
) {
    init {
        require(status == "healthy")
        MobileV2ContractValidation.requireRfc3339(startedAt, "startedAt")
        require(pid > 0)
        require(agents >= 0 && channels >= 0)
        require(apiVersion == 2)
        MobileV2ContractValidation.requireCapabilities(capabilities, "capabilities")
    }
}

@Serializable
data class GatewayIdentity(
    val gatewayId: String,
    val publicKey: String,
) {
    init {
        MobileV2ContractValidation.requireNonEmpty(gatewayId, "gatewayId")
        MobileV2ContractValidation.requireNonEmpty(publicKey, "publicKey")
    }
}

@Serializable
data class MobileV2ActionResponse(val ok: Boolean) {
    init {
        require(ok) { "Mobile v2 action acknowledgement must be true" }
    }
}

/** Strict mobile-v2 agent wire DTO; mapped to the frozen v1 [RegisteredAgent] view by clients. */
@Serializable
data class MobileV2Agent(
    val id: String,
    val name: String,
    val config: MobileV2AgentConfig,
    val status: AgentStatus,
    val registeredAt: String,
) {
    init {
        MobileV2ContractValidation.requireNonEmpty(id, "agent.id")
        MobileV2ContractValidation.requireNonEmpty(name, "agent.name")
        MobileV2ContractValidation.requireRfc3339(registeredAt, "agent.registeredAt")
    }

    fun toRegisteredAgent(): RegisteredAgent = RegisteredAgent(
        id = id,
        name = name,
        config = AgentConfig(
            model = config.model,
            systemPrompt = config.systemPrompt,
            tools = config.tools,
            fallbackModels = config.fallbackModels,
        ),
        status = status,
        registeredAt = registeredAt,
    )
}

@Serializable
data class MobileV2AgentConfig(
    val name: String,
    val model: String,
    val systemPrompt: String,
    val fallbackModels: List<String>? = null,
    val tools: List<String>? = null,
    val skills: MobileV2AgentSkills? = null,
    val workspace: String? = null,
    val maxTokens: Long? = null,
    val mcpServers: List<String>? = null,
    val plugins: List<String>? = null,
    val providers: List<String>? = null,
    val swarm: MobileV2AgentSwarm? = null,
) {
    init {
        MobileV2ContractValidation.requireNonEmpty(name, "agent.config.name")
        MobileV2ContractValidation.requireNonEmpty(model, "agent.config.model")
        listOf(fallbackModels, tools, mcpServers, plugins, providers).forEachIndexed { index, values ->
            values?.forEachIndexed { valueIndex, value ->
                MobileV2ContractValidation.requireNonEmpty(
                    value,
                    "agent.config.lists[$index][$valueIndex]",
                )
            }
        }
        maxTokens?.let {
            MobileV2ContractValidation.requireSafeInteger(it, 1, "agent.config.maxTokens")
        }
    }
}

@Serializable
data class MobileV2AgentSkills(
    val paths: List<String>? = null,
    val urls: List<String>? = null,
) {
    init {
        listOf(paths, urls).forEachIndexed { index, values ->
            values?.forEachIndexed { valueIndex, value ->
                MobileV2ContractValidation.requireNonEmpty(
                    value,
                    "agent.config.skills[$index][$valueIndex]",
                )
            }
        }
    }
}

@Serializable
data class MobileV2AgentSwarm(
    val enabled: Boolean? = null,
    val maxConcurrentWorkers: Long? = null,
    val maxWorkersPerRun: Long? = null,
    val maxSteersPerWorker: Long? = null,
    val maxRunSeconds: Long? = null,
    val allowedModels: List<String>? = null,
) {
    init {
        maxConcurrentWorkers?.let {
            MobileV2ContractValidation.requireSafeInteger(it, 1, "swarm.maxConcurrentWorkers")
        }
        maxWorkersPerRun?.let {
            MobileV2ContractValidation.requireSafeInteger(it, 1, "swarm.maxWorkersPerRun")
        }
        maxSteersPerWorker?.let {
            MobileV2ContractValidation.requireSafeInteger(it, field = "swarm.maxSteersPerWorker")
        }
        maxRunSeconds?.let {
            MobileV2ContractValidation.requireSafeInteger(it, 1, "swarm.maxRunSeconds")
        }
        allowedModels?.forEachIndexed { index, value ->
            MobileV2ContractValidation.requireNonEmpty(value, "swarm.allowedModels[$index]")
        }
    }
}

@Serializable
enum class ConversationStatus {
    @SerialName("idle") IDLE,
    @SerialName("running") RUNNING,
    @SerialName("interrupted") INTERRUPTED,
    @SerialName("archived") ARCHIVED,
    @SerialName("deleted") DELETED,
}

@Serializable
enum class ConversationRole {
    @SerialName("user") USER,
    @SerialName("assistant") ASSISTANT,
}

@Serializable
enum class ConversationMessageStatus {
    @SerialName("accepted") ACCEPTED,
    @SerialName("streaming") STREAMING,
    @SerialName("completed") COMPLETED,
    @SerialName("cancelled") CANCELLED,
    @SerialName("failed") FAILED,
    @SerialName("interrupted") INTERRUPTED,
}

@Serializable
enum class MobileV2DeliveryKind {
    @SerialName("normal") NORMAL,
    @SerialName("steer") STEER,
    @SerialName("follow_up") FOLLOW_UP,
}

@Serializable
enum class MobileV2DeliveryStatus {
    @SerialName("pending") PENDING,
    @SerialName("delivered") DELIVERED,
    @SerialName("not_delivered") NOT_DELIVERED,
}

@Serializable
enum class MobileV2PendingInputKind {
    @SerialName("steer") STEER,
    @SerialName("follow_up") FOLLOW_UP,
}

@Serializable
enum class MobileV2PendingInputState {
    @SerialName("queued") QUEUED,
    @SerialName("delivering") DELIVERING,
    @SerialName("delivered") DELIVERED,
    @SerialName("removed") REMOVED,
    @SerialName("failed") FAILED,
}

@Serializable
enum class MobileV2InputBehavior {
    @SerialName("steer") STEER,
    @SerialName("followUp") FOLLOW_UP,
}

@Serializable
enum class MobileV2TerminalOutcome {
    @SerialName("completed") COMPLETED,
    @SerialName("cancelled") CANCELLED,
    @SerialName("interrupted") INTERRUPTED,
}

@Serializable
enum class MobileApiErrorCode {
    @SerialName("unauthorized") UNAUTHORIZED,
    @SerialName("not_found") NOT_FOUND,
    @SerialName("validation_failed") VALIDATION_FAILED,
    @SerialName("revision_conflict") REVISION_CONFLICT,
    @SerialName("conversation_busy") CONVERSATION_BUSY,
    @SerialName("rate_limited") RATE_LIMITED,
    @SerialName("gateway_offline") GATEWAY_OFFLINE,
    @SerialName("capability_required") CAPABILITY_REQUIRED,
}

@Serializable(with = MobileV2ConversationContentSerializer::class)
sealed interface ConversationContent {
    @Serializable
    @SerialName("user")
    data class User(
        val text: String,
        val images: List<@Serializable(with = MobileV2StrictImageSerializer::class) WsMessageImage>? =
            null,
    ) : ConversationContent {
        init {
            MobileV2ContractValidation.requireImages(images, "content.images")
        }
    }

    @Serializable
    @SerialName("assistant")
    data class Assistant(
        val events: List<
            @Serializable(with = MobileV2StrictAgentEventSerializer::class) AgentEvent,
        >,
    ) : ConversationContent
}

@Serializable(with = MobileV2ConversationSummarySerializer::class)
data class MobileV2ConversationSummary(
    val id: String,
    val agentId: String,
    val agentName: String,
    val title: String,
    val revision: Long,
    val status: ConversationStatus,
    val activeTurnId: String?,
    val owningIssueId: String?,
    val projectId: String?,
    val lastSeq: Long,
    val lastMessagePreview: String?,
    val createdAt: String,
    val updatedAt: String,
    val deletedAt: String? = null,
    val queuePaused: Boolean,
    val queueRevision: Long,
    val pendingFollowUpCount: Long,
    val v2LastSeq: Long,
) {
    init {
        MobileV2ContractValidation.requireCanonicalUuid(id, "conversation.id")
        MobileV2ContractValidation.requireNonEmpty(agentId, "conversation.agentId")
        MobileV2ContractValidation.requireNonEmpty(agentName, "conversation.agentName")
        MobileV2ContractValidation.requireSafeInteger(revision, 1, "conversation.revision")
        activeTurnId?.let {
            MobileV2ContractValidation.requireLegacyRunId(it, "conversation.activeTurnId")
        }
        MobileV2ContractValidation.requireSafeInteger(lastSeq, field = "conversation.lastSeq")
        MobileV2ContractValidation.requireRfc3339(createdAt, "conversation.createdAt")
        MobileV2ContractValidation.requireRfc3339(updatedAt, "conversation.updatedAt")
        deletedAt?.let {
            MobileV2ContractValidation.requireRfc3339(it, "conversation.deletedAt")
        }
        MobileV2ContractValidation.requireSafeInteger(
            queueRevision,
            field = "conversation.queueRevision",
        )
        MobileV2ContractValidation.requireSafeInteger(
            pendingFollowUpCount,
            field = "conversation.pendingFollowUpCount",
        )
        MobileV2ContractValidation.requireSafeInteger(v2LastSeq, field = "conversation.v2LastSeq")
    }
}

@Serializable(with = MobileV2ConversationMessageSerializer::class)
data class MobileV2ConversationMessage(
    val id: String,
    val conversationId: String,
    val turnId: String,
    val ordinal: Long,
    val role: ConversationRole,
    val status: ConversationMessageStatus,
    val content: ConversationContent,
    val createdAt: String,
    val updatedAt: String,
    val runId: String,
    val segmentIndex: Long,
    val deliveryKind: MobileV2DeliveryKind,
    val deliveryStatus: MobileV2DeliveryStatus? = null,
) {
    init {
        MobileV2ContractValidation.requireCanonicalUuid(id, "message.id")
        MobileV2ContractValidation.requireCanonicalUuid(conversationId, "message.conversationId")
        MobileV2ContractValidation.requireLegacyRunId(turnId, "message.turnId")
        MobileV2ContractValidation.requireSafeInteger(ordinal, 1, "message.ordinal")
        MobileV2ContractValidation.requireRfc3339(createdAt, "message.createdAt")
        MobileV2ContractValidation.requireRfc3339(updatedAt, "message.updatedAt")
        MobileV2ContractValidation.requireLegacyRunId(runId, "message.runId")
        MobileV2ContractValidation.requireSafeInteger(segmentIndex, field = "message.segmentIndex")
    }
}

@Serializable(with = MobileV2PendingInputSerializer::class)
data class MobileV2PendingInput(
    val inputId: String,
    val kind: MobileV2PendingInputKind,
    val targetTurnId: String? = null,
    val text: String,
    val images: List<@Serializable(with = MobileV2StrictImageSerializer::class) WsMessageImage>? =
        null,
    val state: MobileV2PendingInputState,
    val revision: Long,
    val enqueueOrder: Long,
    val runId: String? = null,
    val segmentTurnId: String? = null,
    val userMessageId: String? = null,
    val assistantMessageId: String? = null,
    val failureCode: MobileApiErrorCode? = null,
    val failureMessage: String? = null,
    val createdAt: String,
    val updatedAt: String,
    val deliveredAt: String? = null,
) {
    init {
        MobileV2ContractValidation.requireCanonicalUuid(inputId, "input.inputId")
        if (kind == MobileV2PendingInputKind.STEER) {
            require(targetTurnId != null) { "Steer input requires targetTurnId" }
        }
        targetTurnId?.let { MobileV2ContractValidation.requireLegacyRunId(it, "input.targetTurnId") }
        MobileV2ContractValidation.requireImages(images, "input.images")
        MobileV2ContractValidation.requireSafeInteger(revision, field = "input.revision")
        MobileV2ContractValidation.requireSafeInteger(enqueueOrder, field = "input.enqueueOrder")
        runId?.let { MobileV2ContractValidation.requireLegacyRunId(it, "input.runId") }
        segmentTurnId?.let {
            MobileV2ContractValidation.requireCanonicalUuid(it, "input.segmentTurnId")
        }
        userMessageId?.let {
            MobileV2ContractValidation.requireCanonicalUuid(it, "input.userMessageId")
        }
        assistantMessageId?.let {
            MobileV2ContractValidation.requireCanonicalUuid(it, "input.assistantMessageId")
        }
        failureMessage?.let {
            MobileV2ContractValidation.requireNonEmpty(it, "input.failureMessage")
        }
        MobileV2ContractValidation.requireRfc3339(createdAt, "input.createdAt")
        MobileV2ContractValidation.requireRfc3339(updatedAt, "input.updatedAt")
        deliveredAt?.let { MobileV2ContractValidation.requireRfc3339(it, "input.deliveredAt") }
    }
}

@Serializable
data class MobileV2ConversationBootstrap(
    val conversation: MobileV2ConversationSummary,
    val messages: List<MobileV2ConversationMessage>,
    val nextCursor: String?,
    val pendingInputs: List<MobileV2PendingInput>,
    val queuePaused: Boolean,
    val queueRevision: Long,
    val v2ThroughSeq: Long,
) {
    init {
        MobileV2ContractValidation.requireSafeInteger(queueRevision, field = "queueRevision")
        MobileV2ContractValidation.requireSafeInteger(v2ThroughSeq, field = "v2ThroughSeq")
    }
}

@Serializable
data class MobileV2ConversationPage(
    val items: List<MobileV2ConversationSummary>,
    val nextCursor: String?,
)

@Serializable
data class MobileV2ConversationMessagePage(
    val items: List<MobileV2ConversationMessage>,
    val nextCursor: String?,
    val throughSeq: Long,
) {
    init {
        MobileV2ContractValidation.requireSafeInteger(throughSeq, field = "throughSeq")
    }
}

@Serializable
data class MobileV2ReplayPage(
    val frames: List<MobileV2SequencedFrame>,
    val v2ThroughSeq: Long,
) {
    init {
        MobileV2ContractValidation.requireSafeInteger(v2ThroughSeq, field = "v2ThroughSeq")
    }
}

@Serializable
data class MobileApiError(
    val code: MobileApiErrorCode,
    val error: String,
    val retryable: Boolean,
    val details: JsonObject? = null,
) {
    init {
        MobileV2ContractValidation.requireNonEmpty(error, "error")
    }
}

object MobileV2ConversationContentSerializer : KSerializer<ConversationContent> {
    override val descriptor: SerialDescriptor = JsonObject.serializer().descriptor

    override fun deserialize(decoder: Decoder): ConversationContent {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("Mobile v2 content requires JSON")
        val source = input.decodeJsonElement() as? JsonObject
            ?: throw SerializationException("Mobile v2 content must be an object")
        rejectExplicitNulls(source)
        val type = source.requiredString("type")
        val payload = JsonObject(source.filterKeys { it != "type" })
        return when (type) {
            "user" -> input.json.decodeFromJsonElement(ConversationContent.User.serializer(), payload)
            "assistant" ->
                input.json.decodeFromJsonElement(ConversationContent.Assistant.serializer(), payload)
            else -> throw SerializationException("Unknown mobile v2 content type: $type")
        }
    }

    override fun serialize(encoder: Encoder, value: ConversationContent) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("Mobile v2 content requires JSON")
        val (type, payload) = when (value) {
            is ConversationContent.User -> "user" to output.json.encodeToJsonElement(
                ConversationContent.User.serializer(),
                value,
            ).jsonObject
            is ConversationContent.Assistant -> "assistant" to output.json.encodeToJsonElement(
                ConversationContent.Assistant.serializer(),
                value,
            ).jsonObject
        }
        output.encodeJsonElement(
            buildJsonObject {
                put("type", type)
                payload.forEach { (key, element) -> put(key, element) }
            },
        )
    }
}

object MobileV2ConversationSummarySerializer : KSerializer<MobileV2ConversationSummary> {
    override val descriptor: SerialDescriptor = MobileV2ConversationSummarySurrogate.serializer().descriptor

    override fun deserialize(decoder: Decoder): MobileV2ConversationSummary {
        val input = decoder.requireV2JsonDecoder("conversation summary")
        val source = input.decodeV2Object("conversation summary")
        rejectExplicitNulls(source, setOf("deletedAt"))
        return input.json.decodeFromJsonElement(
            MobileV2ConversationSummarySurrogate.serializer(),
            source,
        ).toValue()
    }

    override fun serialize(encoder: Encoder, value: MobileV2ConversationSummary) {
        encoder.encodeSerializableValue(
            MobileV2ConversationSummarySurrogate.serializer(),
            MobileV2ConversationSummarySurrogate(value),
        )
    }
}

@Serializable
private data class MobileV2ConversationSummarySurrogate(
    val id: String,
    val agentId: String,
    val agentName: String,
    val title: String,
    val revision: Long,
    val status: ConversationStatus,
    val activeTurnId: String?,
    val owningIssueId: String?,
    val projectId: String?,
    val lastSeq: Long,
    val lastMessagePreview: String?,
    val createdAt: String,
    val updatedAt: String,
    val deletedAt: String? = null,
    val queuePaused: Boolean,
    val queueRevision: Long,
    val pendingFollowUpCount: Long,
    val v2LastSeq: Long,
) {
    constructor(value: MobileV2ConversationSummary) : this(
        value.id,
        value.agentId,
        value.agentName,
        value.title,
        value.revision,
        value.status,
        value.activeTurnId,
        value.owningIssueId,
        value.projectId,
        value.lastSeq,
        value.lastMessagePreview,
        value.createdAt,
        value.updatedAt,
        value.deletedAt,
        value.queuePaused,
        value.queueRevision,
        value.pendingFollowUpCount,
        value.v2LastSeq,
    )

    fun toValue() = MobileV2ConversationSummary(
        id,
        agentId,
        agentName,
        title,
        revision,
        status,
        activeTurnId,
        owningIssueId,
        projectId,
        lastSeq,
        lastMessagePreview,
        createdAt,
        updatedAt,
        deletedAt,
        queuePaused,
        queueRevision,
        pendingFollowUpCount,
        v2LastSeq,
    )
}

object MobileV2ConversationMessageSerializer : KSerializer<MobileV2ConversationMessage> {
    override val descriptor: SerialDescriptor = MobileV2ConversationMessageSurrogate.serializer().descriptor

    override fun deserialize(decoder: Decoder): MobileV2ConversationMessage {
        val input = decoder.requireV2JsonDecoder("conversation message")
        val source = input.decodeV2Object("conversation message")
        rejectExplicitNulls(source, setOf("deliveryStatus"))
        return input.json.decodeFromJsonElement(
            MobileV2ConversationMessageSurrogate.serializer(),
            source,
        ).toValue()
    }

    override fun serialize(encoder: Encoder, value: MobileV2ConversationMessage) {
        encoder.encodeSerializableValue(
            MobileV2ConversationMessageSurrogate.serializer(),
            MobileV2ConversationMessageSurrogate(value),
        )
    }
}

@Serializable
private data class MobileV2ConversationMessageSurrogate(
    val id: String,
    val conversationId: String,
    val turnId: String,
    val ordinal: Long,
    val role: ConversationRole,
    val status: ConversationMessageStatus,
    val content: ConversationContent,
    val createdAt: String,
    val updatedAt: String,
    val runId: String,
    val segmentIndex: Long,
    val deliveryKind: MobileV2DeliveryKind,
    val deliveryStatus: MobileV2DeliveryStatus? = null,
) {
    constructor(value: MobileV2ConversationMessage) : this(
        value.id,
        value.conversationId,
        value.turnId,
        value.ordinal,
        value.role,
        value.status,
        value.content,
        value.createdAt,
        value.updatedAt,
        value.runId,
        value.segmentIndex,
        value.deliveryKind,
        value.deliveryStatus,
    )

    fun toValue() = MobileV2ConversationMessage(
        id,
        conversationId,
        turnId,
        ordinal,
        role,
        status,
        content,
        createdAt,
        updatedAt,
        runId,
        segmentIndex,
        deliveryKind,
        deliveryStatus,
    )
}

object MobileV2PendingInputSerializer : KSerializer<MobileV2PendingInput> {
    override val descriptor: SerialDescriptor = MobileV2PendingInputSurrogate.serializer().descriptor

    override fun deserialize(decoder: Decoder): MobileV2PendingInput {
        val input = decoder.requireV2JsonDecoder("pending input")
        val source = input.decodeV2Object("pending input")
        rejectExplicitNulls(source, PENDING_OPTIONAL_KEYS)
        return input.json.decodeFromJsonElement(MobileV2PendingInputSurrogate.serializer(), source)
            .toValue()
    }

    override fun serialize(encoder: Encoder, value: MobileV2PendingInput) {
        encoder.encodeSerializableValue(
            MobileV2PendingInputSurrogate.serializer(),
            MobileV2PendingInputSurrogate(value),
        )
    }
}

@Serializable
private data class MobileV2PendingInputSurrogate(
    val inputId: String,
    val kind: MobileV2PendingInputKind,
    val targetTurnId: String? = null,
    val text: String,
    val images: List<@Serializable(with = MobileV2StrictImageSerializer::class) WsMessageImage>? =
        null,
    val state: MobileV2PendingInputState,
    val revision: Long,
    val enqueueOrder: Long,
    val runId: String? = null,
    val segmentTurnId: String? = null,
    val userMessageId: String? = null,
    val assistantMessageId: String? = null,
    val failureCode: MobileApiErrorCode? = null,
    val failureMessage: String? = null,
    val createdAt: String,
    val updatedAt: String,
    val deliveredAt: String? = null,
) {
    constructor(value: MobileV2PendingInput) : this(
        value.inputId,
        value.kind,
        value.targetTurnId,
        value.text,
        value.images,
        value.state,
        value.revision,
        value.enqueueOrder,
        value.runId,
        value.segmentTurnId,
        value.userMessageId,
        value.assistantMessageId,
        value.failureCode,
        value.failureMessage,
        value.createdAt,
        value.updatedAt,
        value.deliveredAt,
    )

    fun toValue() = MobileV2PendingInput(
        inputId,
        kind,
        targetTurnId,
        text,
        images,
        state,
        revision,
        enqueueOrder,
        runId,
        segmentTurnId,
        userMessageId,
        assistantMessageId,
        failureCode,
        failureMessage,
        createdAt,
        updatedAt,
        deliveredAt,
    )
}

private val PENDING_OPTIONAL_KEYS = setOf(
    "targetTurnId",
    "images",
    "runId",
    "segmentTurnId",
    "userMessageId",
    "assistantMessageId",
    "failureCode",
    "failureMessage",
    "deliveredAt",
)

private fun Decoder.requireV2JsonDecoder(kind: String): JsonDecoder = this as? JsonDecoder
    ?: throw SerializationException("Mobile v2 $kind requires JSON")

private fun JsonDecoder.decodeV2Object(kind: String): JsonObject = decodeJsonElement() as? JsonObject
    ?: throw SerializationException("Mobile v2 $kind must be an object")

private fun rejectExplicitNulls(source: JsonObject, keys: Set<String> = source.keys) {
    keys.forEach { key ->
        if (source[key] is JsonNull) {
            throw SerializationException("Mobile v2 field $key may be omitted but not null")
        }
    }
}

private fun JsonObject.requiredString(key: String): String {
    val primitive = this[key] as? JsonPrimitive
        ?: throw SerializationException("$key must be a JSON string")
    if (!primitive.isString) throw SerializationException("$key must be a JSON string")
    return primitive.content
}
