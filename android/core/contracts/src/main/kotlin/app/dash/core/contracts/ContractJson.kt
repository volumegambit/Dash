package app.dash.core.contracts

import java.math.BigDecimal
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

object ContractJson {
  val strict = Json {
    classDiscriminator = "type"
    ignoreUnknownKeys = false
    explicitNulls = true
    encodeDefaults = false
    isLenient = false
    allowStructuredMapKeys = false
  }
}

internal fun JsonPrimitive.integralLongOrNull(): Long? {
  if (isString) return null
  return try {
    BigDecimal(content).longValueExact()
  } catch (_: NumberFormatException) {
    null
  } catch (_: ArithmeticException) {
    null
  }
}

internal object JsonIntegralLongSerializer : KSerializer<Long> {
  override val descriptor = PrimitiveSerialDescriptor("JsonIntegralLong", PrimitiveKind.LONG)

  override fun deserialize(decoder: Decoder): Long {
    if (decoder !is JsonDecoder) return decoder.decodeLong()
    val primitive = decoder.decodeJsonElement() as? JsonPrimitive
    return primitive?.integralLongOrNull()
      ?: throw SerializationException("expected an integral JSON number in Long range")
  }

  override fun serialize(encoder: Encoder, value: Long) = encoder.encodeLong(value)
}

internal object JsonIntegralIntSerializer : KSerializer<Int> {
  override val descriptor = PrimitiveSerialDescriptor("JsonIntegralInt", PrimitiveKind.INT)

  override fun deserialize(decoder: Decoder): Int {
    if (decoder !is JsonDecoder) return decoder.decodeInt()
    val primitive = decoder.decodeJsonElement() as? JsonPrimitive
    val value = primitive?.integralLongOrNull()
    if (value == null || value !in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) {
      throw SerializationException("expected an integral JSON number in Int range")
    }
    return value.toInt()
  }

  override fun serialize(encoder: Encoder, value: Int) = encoder.encodeInt(value)
}

object WireRules {
  private val uuid = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
  private val modelIdentifier = Regex("^[^/]+/.+$")
  private val ecmaScriptWhitespace = Regex(
    "[\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]",
  )
  private val rfc3339 = Regex(
    "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$",
    RegexOption.IGNORE_CASE,
  )
  private val isoDate = Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
  private val memoryTypes = setOf("user", "feedback", "project", "reference")
  private val memorySources = setOf("agent", "sweep", "user", "import")
  private val apiErrorCodes = setOf(
    "unauthorized",
    "not_found",
    "validation_failed",
    "revision_conflict",
    "conversation_busy",
    "rate_limited",
    "gateway_offline",
    "capability_required",
  )
  private val knownAgentEventTypes = setOf(
    "text_delta",
    "thinking_delta",
    "tool_use_start",
    "tool_use_delta",
    "tool_result",
    "response",
    "error",
    "file_changed",
    "agent_spawned",
    "worker_spawned",
    "worker_status",
    "worker_done",
    "agent_retry",
    "context_compacted",
    "question",
    "skill_loaded",
    "skill_created",
    "mcp_server_error",
    "memory_saved",
    "memory_forgotten",
  )
  private val recognizedStringFields = setOf(
    "text",
    "id",
    "name",
    "partial_json",
    "content",
    "error",
    "timestamp",
    "workerId",
    "runId",
    "role",
    "brief",
    "model",
    "status",
    "detail",
    "question",
    "report",
    "reason",
    "description",
    "server",
    "memoryType",
    "action",
  )

  fun requireNonempty(value: String, field: String): String = value.also {
    require(it.isNotEmpty()) { "$field must be nonempty" }
  }

  fun requireNonblank(value: String, field: String): String = value.also {
    require(it.isNotBlank()) { "$field must be nonblank" }
  }

  fun requireCodePointLength(
    value: String,
    minimum: Int,
    maximum: Int,
    field: String,
  ): String = value.also {
    val length = it.codePointCount(0, it.length)
    require(length in minimum..maximum) {
      "$field must contain between $minimum and $maximum Unicode code points"
    }
  }

  fun requireUuid(value: String, field: String): String = value.also {
    require(uuid.matches(it)) { "$field must be a UUID" }
  }

  fun requirePositive(value: Long, field: String): Long = value.also {
    require(it > 0) { "$field must be positive" }
  }

  fun requireNonnegative(value: Long, field: String): Long = value.also {
    require(it >= 0) { "$field must be nonnegative" }
  }

  fun requireRfc3339(value: String, field: String): String = value.also {
    require(rfc3339.matches(it)) { "$field must be RFC 3339" }
    try {
      OffsetDateTime.parse(it)
    } catch (_: DateTimeParseException) {
      throw IllegalArgumentException("$field must be RFC 3339")
    }
  }

  fun requireIsoDate(value: String, field: String): String = value.also {
    require(isoDate.matches(it)) { "$field must be an ISO date" }
    try {
      LocalDate.parse(it)
    } catch (_: DateTimeParseException) {
      throw IllegalArgumentException("$field must be an ISO date")
    }
  }

  fun requireModelIdentifier(value: String, field: String): String = value.also {
    requireCodePointLength(it, 3, Int.MAX_VALUE, field)
    requireNoEcmaScriptWhitespace(it, field)
    require(modelIdentifier.matches(it)) { "$field must be provider/model" }
  }

  fun requireNoEcmaScriptWhitespace(value: String, field: String): String = value.also {
    require(!ecmaScriptWhitespace.containsMatchIn(it)) { "$field must not contain whitespace" }
  }

  fun requireMemoryType(value: String, field: String): String = value.also {
    require(it in memoryTypes) { "$field must be a known memory type" }
  }

  fun requireMemorySource(value: String, field: String): String = value.also {
    require(it in memorySources) { "$field must be a known memory source" }
  }

  fun requireApiErrorCode(value: String, field: String): String = value.also {
    require(it in apiErrorCodes) { "$field must be a known API error code" }
  }

  internal fun validateAgentEvent(raw: JsonObject) {
    val type = raw.requiredEventString("type")
    if (type !in knownAgentEventTypes) return

    recognizedStringFields.forEach { field -> raw.optionalEventString(field) }
    raw["timestamp"]?.takeUnless { it === JsonNull }?.let { timestamp ->
      requireRfc3339(timestamp.stringForEvent("timestamp"), "AgentEvent.timestamp")
    }
    raw.optionalEventBoolean("isError")
    raw.optionalEventBoolean("overflow")
    raw.optionalEventInteger("attempt")
    raw.optionalEventStringArray("files")
    raw.optionalEventStringArray("options")
    raw.optionalEventUsage("usage")

    when (type) {
      "text_delta", "thinking_delta" -> raw.requiredEventString("text")
      "tool_use_start" -> {
        raw.requiredEventString("id")
        raw.requiredEventString("name")
      }
      "tool_use_delta" -> raw.requiredEventString("partial_json")
      "tool_result" -> {
        raw.requiredEventString("id")
        raw.requiredEventString("name")
        raw.requiredEventString("content")
      }
      "response" -> {
        raw.requiredEventString("content")
        raw.requiredEventUsage("usage")
      }
      "error" -> raw.requiredEventString("error")
      "file_changed" -> raw.requiredEventStringArray("files")
      "agent_spawned", "skill_loaded", "memory_forgotten" -> raw.requiredEventString("name")
      "worker_spawned" -> {
        listOf("workerId", "runId", "role", "brief", "model").forEach {
          raw.requiredEventString(it)
        }
      }
      "worker_status" -> {
        listOf("workerId", "runId", "role").forEach { raw.requiredEventString(it) }
        require(raw.requiredEventString("status") in setOf("running", "waiting_input")) {
          "AgentEvent worker_status has invalid status"
        }
      }
      "worker_done" -> {
        listOf("workerId", "runId", "role", "report").forEach { raw.requiredEventString(it) }
        require(raw.requiredEventString("status") in setOf("done", "failed", "cancelled")) {
          "AgentEvent worker_done has invalid status"
        }
      }
      "agent_retry" -> {
        raw.requiredEventInteger("attempt")
        raw.requiredEventString("reason")
      }
      "context_compacted" -> raw.requiredEventBoolean("overflow")
      "question" -> {
        raw.requiredEventString("id")
        raw.requiredEventString("question")
        raw.requiredEventStringArray("options")
      }
      "skill_created" -> {
        raw.requiredEventString("name")
        raw.requiredEventString("description")
      }
      "mcp_server_error" -> {
        raw.requiredEventString("server")
        raw.requiredEventString("error")
      }
      "memory_saved" -> {
        val memoryType = raw.requiredEventString("memoryType")
        if (memoryType !in memoryTypes) return
        val action = raw.requiredEventString("action")
        if (action !in setOf("created", "updated")) return
        raw.requiredEventString("name")
        raw.requiredEventString("description")
      }
    }
  }

  private fun JsonObject.requiredEventString(field: String): String =
    (get(field) as? JsonPrimitive)
      ?.takeIf(JsonPrimitive::isString)
      ?.content
      ?: throw SerializationException("AgentEvent requires string $field")

  private fun JsonElement.stringForEvent(field: String): String =
    (this as? JsonPrimitive)
      ?.takeIf(JsonPrimitive::isString)
      ?.content
      ?: throw SerializationException("AgentEvent $field must be a string")

  private fun JsonObject.optionalEventString(field: String) {
    val value = get(field) ?: return
    if (value === JsonNull) return
    if (value !is JsonPrimitive || !value.isString) {
      throw SerializationException("AgentEvent $field must be a string")
    }
  }

  private fun JsonObject.requiredEventInteger(field: String): Long =
    get(field)?.takeUnless { it === JsonNull }?.let { value ->
      (value as? JsonPrimitive)?.integralLongOrNull()
    } ?: throw SerializationException("AgentEvent requires integer $field")

  private fun JsonObject.optionalEventInteger(field: String) {
    val value = get(field) ?: return
    if (value === JsonNull) return
    if (value !is JsonPrimitive || value.integralLongOrNull() == null) {
      throw SerializationException("AgentEvent $field must be an integer")
    }
  }

  private fun JsonObject.requiredEventBoolean(field: String): Boolean =
    get(field)?.takeUnless { it === JsonNull }?.let { value ->
      (value as? JsonPrimitive)?.takeUnless(JsonPrimitive::isString)?.booleanOrNull
    } ?: throw SerializationException("AgentEvent requires boolean $field")

  private fun JsonObject.optionalEventBoolean(field: String) {
    val value = get(field) ?: return
    if (value === JsonNull) return
    if (value !is JsonPrimitive || value.isString || value.booleanOrNull == null) {
      throw SerializationException("AgentEvent $field must be a boolean")
    }
  }

  private fun JsonObject.requiredEventStringArray(field: String): JsonArray =
    get(field)?.takeUnless { it === JsonNull }?.let { value ->
      (value as? JsonArray)?.also { array ->
        if (array.any { it !is JsonPrimitive || !it.isString }) {
          throw SerializationException("AgentEvent $field must contain strings")
        }
      }
    } ?: throw SerializationException("AgentEvent requires string array $field")

  private fun JsonObject.optionalEventStringArray(field: String) {
    val value = get(field) ?: return
    if (value === JsonNull) return
    if (value !is JsonArray || value.any { it !is JsonPrimitive || !it.isString }) {
      throw SerializationException("AgentEvent $field must contain strings")
    }
  }

  private fun JsonObject.requiredEventUsage(field: String): JsonObject =
    get(field)?.takeUnless { it === JsonNull }?.let { value ->
      (value as? JsonObject)?.also(::validateUsage)
    } ?: throw SerializationException("AgentEvent requires object $field")

  private fun JsonObject.optionalEventUsage(field: String) {
    val value = get(field) ?: return
    if (value === JsonNull) return
    val usage = value as? JsonObject
      ?: throw SerializationException("AgentEvent $field must be an object")
    validateUsage(usage)
  }

  private fun validateUsage(usage: JsonObject) {
    usage.requiredEventInteger("inputTokens")
    usage.requiredEventInteger("outputTokens")
    usage.optionalEventInteger("cacheReadTokens")
    usage.optionalEventInteger("cacheWriteTokens")
  }
}
