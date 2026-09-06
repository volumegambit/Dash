package app.dash.core.contracts

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.longOrNull

@Serializable
enum class WireDocument {
  @SerialName("openapi")
  OpenApi,

  @SerialName("chat-ws")
  ChatWs,

  @SerialName("internal")
  Internal,
}

sealed class WireContract<T> protected constructor(
  val document: WireDocument,
  val schema: String,
  internal val serializer: KSerializer<T>,
  internal val validateRaw: (JsonElement) -> Unit,
)

private class DefinedWireContract<T>(
  document: WireDocument,
  schema: String,
  serializer: KSerializer<T>,
  validateRaw: (JsonElement) -> Unit,
) : WireContract<T>(document, schema, serializer, validateRaw)

private fun <T> define(
  document: WireDocument,
  schema: String,
  serializer: KSerializer<T>,
  validateRaw: (JsonElement) -> Unit,
): WireContract<T> = DefinedWireContract(document, schema, serializer, validateRaw)

object WireContractValidator {
  fun <T> assertRuntimeShape(contract: WireContract<T>, value: JsonElement) {
    contract.validateRaw(value)
  }

  fun <T> decodeRuntime(contract: WireContract<T>, value: JsonElement): T {
    contract.validateRaw(value)
    return ContractJson.strict.decodeFromJsonElement(contract.serializer, value)
  }

  fun <T> encodeRuntime(contract: WireContract<T>, value: T): JsonElement =
    ContractJson.strict.encodeToJsonElement(contract.serializer, value)
      .also(contract.validateRaw)
}

object WireContracts {
  val MobileHealth: WireContract<app.dash.core.contracts.MobileHealth> = define(
    WireDocument.OpenApi,
    "MobileHealth",
    app.dash.core.contracts.MobileHealth.serializer(),
    ::validateMobileHealth,
  )
  val GatewayIdentity: WireContract<app.dash.core.contracts.GatewayIdentity> = define(
    WireDocument.OpenApi,
    "GatewayIdentity",
    app.dash.core.contracts.GatewayIdentity.serializer(),
    ::validateGatewayIdentity,
  )
  val WsTicketResponse: WireContract<app.dash.core.contracts.WsTicketResponse> = define(
    WireDocument.OpenApi,
    "WsTicketResponse",
    app.dash.core.contracts.WsTicketResponse.serializer(),
    ::validateWsTicketResponse,
  )
  val MobileAgent: WireContract<app.dash.core.contracts.MobileAgent> = define(
    WireDocument.OpenApi,
    "MobileAgent",
    app.dash.core.contracts.MobileAgent.serializer(),
    ::validateMobileAgent,
  )
  val MobileAgentList: WireContract<List<app.dash.core.contracts.MobileAgent>> = define(
    WireDocument.OpenApi,
    "MobileAgentList",
    ListSerializer(app.dash.core.contracts.MobileAgent.serializer()),
    ::validateMobileAgentList,
  )
  val CreateMobileAgentRequest: WireContract<app.dash.core.contracts.CreateMobileAgentRequest> =
    define(
      WireDocument.OpenApi,
      "CreateMobileAgentRequest",
      app.dash.core.contracts.CreateMobileAgentRequest.serializer(),
      ::validateCreateMobileAgentRequest,
    )
  val UpdateMobileAgentRequest: WireContract<app.dash.core.contracts.UpdateMobileAgentRequest> =
    define(
      WireDocument.OpenApi,
      "UpdateMobileAgentRequest",
      app.dash.core.contracts.UpdateMobileAgentRequest.serializer(),
      ::validateUpdateMobileAgentRequest,
    )
  val MobileActionResponse: WireContract<app.dash.core.contracts.MobileActionResponse> = define(
    WireDocument.OpenApi,
    "MobileActionResponse",
    app.dash.core.contracts.MobileActionResponse.serializer(),
    ::validateMobileActionResponse,
  )
  val MobileSkillList: WireContract<List<MobileSkill>> = define(
    WireDocument.OpenApi,
    "MobileSkillList",
    ListSerializer(MobileSkill.serializer()),
    ::validateMobileSkillList,
  )
  val MemoryInfoList: WireContract<List<MobileMemoryInfo>> = define(
    WireDocument.OpenApi,
    "MemoryInfoList",
    ListSerializer(MobileMemoryInfo.serializer()),
    ::validateMemoryInfoList,
  )
  val MemoryRecord: WireContract<MobileMemoryRecord> = define(
    WireDocument.OpenApi,
    "MemoryRecord",
    MobileMemoryRecord.serializer(),
    ::validateMemoryRecord,
  )
  val MemoryDeleteResponse: WireContract<MobileMemoryDeleteResponse> = define(
    WireDocument.OpenApi,
    "MemoryDeleteResponse",
    MobileMemoryDeleteResponse.serializer(),
    ::validateMemoryDeleteResponse,
  )
  val MemoryNotFoundError: WireContract<app.dash.core.contracts.MemoryNotFoundError> = define(
    WireDocument.OpenApi,
    "MemoryNotFoundError",
    app.dash.core.contracts.MemoryNotFoundError.serializer(),
    ::validateMemoryNotFoundError,
  )
  val MobileModelsResponse: WireContract<app.dash.core.contracts.MobileModelsResponse> = define(
    WireDocument.OpenApi,
    "MobileModelsResponse",
    app.dash.core.contracts.MobileModelsResponse.serializer(),
    ::validateMobileModelsResponse,
  )
  val MobileApiError: WireContract<app.dash.core.contracts.MobileApiError> = define(
    WireDocument.OpenApi,
    "MobileApiError",
    app.dash.core.contracts.MobileApiError.serializer(),
    ::validateMobileApiError,
  )
  val ConversationBusyError: WireContract<MobileApiError> = define(
    WireDocument.OpenApi,
    "ConversationBusyError",
    app.dash.core.contracts.MobileApiError.serializer(),
    ::validateConversationBusyError,
  )
  val ConversationDefaults: WireContract<app.dash.core.contracts.ConversationDefaults> = define(
    WireDocument.OpenApi,
    "ConversationDefaults",
    app.dash.core.contracts.ConversationDefaults.serializer(),
    ::validateConversationDefaults,
  )
  val ConversationSummary: WireContract<app.dash.core.contracts.ConversationSummary> = define(
    WireDocument.OpenApi,
    "ConversationSummary",
    app.dash.core.contracts.ConversationSummary.serializer(),
    ::validateConversationSummary,
  )
  val ConversationPage: WireContract<app.dash.core.contracts.ConversationPage> = define(
    WireDocument.OpenApi,
    "ConversationPage",
    app.dash.core.contracts.ConversationPage.serializer(),
    ::validateConversationPage,
  )
  val ConversationMessagePage: WireContract<app.dash.core.contracts.ConversationMessagePage> =
    define(
      WireDocument.OpenApi,
      "ConversationMessagePage",
      app.dash.core.contracts.ConversationMessagePage.serializer(),
      ::validateConversationMessagePage,
    )
  val ConversationCreateRequest: WireContract<app.dash.core.contracts.ConversationCreateRequest> =
    define(
      WireDocument.OpenApi,
      "ConversationCreateRequest",
      app.dash.core.contracts.ConversationCreateRequest.serializer(),
      ::validateConversationCreateRequest,
    )
  val ConversationPatchRequest: WireContract<app.dash.core.contracts.ConversationPatchRequest> =
    define(
      WireDocument.OpenApi,
      "ConversationPatchRequest",
      app.dash.core.contracts.ConversationPatchRequest.serializer(),
      ::validateConversationPatchRequest,
    )
  val RevisionConflictError: WireContract<MobileApiError> = define(
    WireDocument.OpenApi,
    "RevisionConflictError",
    app.dash.core.contracts.MobileApiError.serializer(),
    ::validateRevisionConflictError,
  )
  val ConversationContent: WireContract<app.dash.core.contracts.ConversationContent> = define(
    WireDocument.Internal,
    "ConversationContent",
    app.dash.core.contracts.ConversationContent.serializer(),
    ::validateConversationContent,
  )
  val ChatSend: WireContract<MobileWsClientFrame> = define(
    WireDocument.ChatWs,
    "ChatSend",
    app.dash.core.contracts.MobileWsClientFrame.serializer(),
    ::validateChatSend,
  )
  val ChatResume: WireContract<MobileWsClientFrame> = define(
    WireDocument.ChatWs,
    "ChatResume",
    app.dash.core.contracts.MobileWsClientFrame.serializer(),
    ::validateChatResume,
  )
  val ChatAnswer: WireContract<MobileWsClientFrame> = define(
    WireDocument.ChatWs,
    "ChatAnswer",
    app.dash.core.contracts.MobileWsClientFrame.serializer(),
    ::validateChatAnswer,
  )
  val ChatCancel: WireContract<MobileWsClientFrame> = define(
    WireDocument.ChatWs,
    "ChatCancel",
    app.dash.core.contracts.MobileWsClientFrame.serializer(),
    ::validateChatCancel,
  )
  val MobileWsClientFrame: WireContract<app.dash.core.contracts.MobileWsClientFrame> = define(
    WireDocument.ChatWs,
    "MobileWsClientFrame",
    app.dash.core.contracts.MobileWsClientFrame.serializer(),
    ::validateMobileWsClientFrame,
  )
  val ChatAccepted: WireContract<MobileWsServerFrame> = define(
    WireDocument.ChatWs,
    "ChatAccepted",
    app.dash.core.contracts.MobileWsServerFrame.serializer(),
    ::validateChatAccepted,
  )
  val ChatEvent: WireContract<MobileWsServerFrame> = define(
    WireDocument.ChatWs,
    "ChatEvent",
    app.dash.core.contracts.MobileWsServerFrame.serializer(),
    ::validateChatEvent,
  )
  val ChatDone: WireContract<MobileWsServerFrame> = define(
    WireDocument.ChatWs,
    "ChatDone",
    app.dash.core.contracts.MobileWsServerFrame.serializer(),
    ::validateChatDone,
  )
  val ChatError: WireContract<MobileWsServerFrame> = define(
    WireDocument.ChatWs,
    "ChatError",
    app.dash.core.contracts.MobileWsServerFrame.serializer(),
    ::validateChatError,
  )
  val MobileWsServerFrame: WireContract<app.dash.core.contracts.MobileWsServerFrame> = define(
    WireDocument.ChatWs,
    "MobileWsServerFrame",
    app.dash.core.contracts.MobileWsServerFrame.serializer(),
    ::validateMobileWsServerFrame,
  )
  val ReplayPage: WireContract<app.dash.core.contracts.ReplayPage> = define(
    WireDocument.OpenApi,
    "ReplayPage",
    app.dash.core.contracts.ReplayPage.serializer(),
    ::validateReplayPage,
  )
  val ConversationChangedEvent: WireContract<GatewayInvalidation> = define(
    WireDocument.OpenApi,
    "ConversationChangedEvent",
    GatewayInvalidation.serializer(),
    ::validateConversationChanged,
  )
  val ConversationDeletedEvent: WireContract<GatewayInvalidation> = define(
    WireDocument.OpenApi,
    "ConversationDeletedEvent",
    GatewayInvalidation.serializer(),
    ::validateConversationDeleted,
  )
  val StoredGatewayEventPayload: WireContract<JsonObject> = define(
    WireDocument.Internal,
    "StoredGatewayEventPayload",
    JsonObject.serializer(),
    ::validateStoredGatewayEventPayload,
  )
  val MobileAgentConfig: WireContract<app.dash.core.contracts.MobileAgentConfig> = define(
    WireDocument.Internal,
    "MobileAgentConfig",
    app.dash.core.contracts.MobileAgentConfig.serializer(),
    ::validateMobileAgentConfig,
  )

  private val replayAcceptedContract: WireContract<ReplayPayload> = define(
    WireDocument.Internal,
    "ReplayPayload.Accepted",
    ReplayPayload.serializer(),
    ::validateReplayAccepted,
  )
  private val replayEventContract: WireContract<ReplayPayload> = define(
    WireDocument.Internal,
    "ReplayPayload.Event",
    ReplayPayload.serializer(),
    ::validateReplayEvent,
  )
  private val replayDoneContract: WireContract<ReplayPayload> = define(
    WireDocument.Internal,
    "ReplayPayload.Done",
    ReplayPayload.serializer(),
    ::validateReplayDone,
  )
  private val replayErrorContract: WireContract<ReplayPayload> = define(
    WireDocument.Internal,
    "ReplayPayload.Error",
    ReplayPayload.serializer(),
    ::validateReplayError,
  )

  private fun validateStoredGatewayEventPayload(value: JsonElement) {
    val raw = value.objectFor("StoredGatewayEventPayload")
    val type = raw.requiredString("type")
    val contract: WireContract<*> = if ("id" in raw) {
      when (type) {
        "accepted" -> ChatAccepted
        "event" -> ChatEvent
        "done" -> ChatDone
        "error" -> ChatError
        else -> throw IllegalArgumentException("unsupported stored full frame type")
      }
    } else {
      when (type) {
        "accepted" -> replayAcceptedContract
        "event" -> replayEventContract
        "done" -> replayDoneContract
        "error" -> replayErrorContract
        else -> throw IllegalArgumentException("unsupported stored replay payload type")
      }
    }
    decodeErased(contract, raw)
  }

  @Suppress("UNCHECKED_CAST")
  private fun decodeErased(contract: WireContract<*>, value: JsonElement) {
    WireContractValidator.decodeRuntime(contract as WireContract<Any?>, value)
  }
}

private fun validateMobileHealth(value: JsonElement) {
  val raw = value.objectFor("MobileHealth")
  raw.shape(
    required = setOf("status", "startedAt", "pid", "agents", "channels", "apiVersion", "capabilities"),
  )
  require(raw.requiredString("status") == "healthy")
  WireRules.requireRfc3339(raw.requiredString("startedAt"), "MobileHealth.startedAt")
  WireRules.requirePositive(raw.requiredLong("pid"), "MobileHealth.pid")
  WireRules.requireNonnegative(raw.requiredLong("agents"), "MobileHealth.agents")
  WireRules.requireNonnegative(raw.requiredLong("channels"), "MobileHealth.channels")
  require(raw.requiredLong("apiVersion") == 1L)
  val capabilities = raw.requiredArray("capabilities").map { node ->
    node.stringFor("MobileHealth.capabilities[]")
  }
  require(capabilities.toSet().size == capabilities.size)
  require(capabilities.all { it in setOf("conversation-sync-v1", "chat-resume-v1") })
}

private fun validateGatewayIdentity(value: JsonElement) {
  val raw = value.objectFor("GatewayIdentity")
  raw.shape(setOf("gatewayId", "publicKey"))
  WireRules.requireNonempty(raw.requiredString("gatewayId"), "GatewayIdentity.gatewayId")
  WireRules.requireNonempty(raw.requiredString("publicKey"), "GatewayIdentity.publicKey")
}

private fun validateWsTicketResponse(value: JsonElement) {
  val raw = value.objectFor("WsTicketResponse")
  raw.shape(setOf("ticket", "expiresAt"))
  require(raw.requiredString("ticket").length >= 32)
  WireRules.requireRfc3339(raw.requiredString("expiresAt"), "WsTicketResponse.expiresAt")
}

private fun validateMobileAgentList(value: JsonElement) {
  value.arrayFor("MobileAgentList").forEach(::validateMobileAgent)
}

private fun validateMobileAgent(value: JsonElement) {
  val raw = value.objectFor("MobileAgent")
  raw.shape(setOf("id", "name", "config", "status", "registeredAt"))
  WireRules.requireNonempty(raw.requiredString("id"), "MobileAgent.id")
  WireRules.requireNonempty(raw.requiredString("name"), "MobileAgent.name")
  validateMobileAgentConfig(raw.getValue("config"))
  require(raw.requiredString("status") in setOf("registered", "active", "disabled"))
  WireRules.requireRfc3339(raw.requiredString("registeredAt"), "MobileAgent.registeredAt")
}

private fun validateMobileAgentConfig(value: JsonElement) {
  val raw = value.objectFor("MobileAgentConfig")
  raw.shape(
    required = setOf("name", "model", "systemPrompt"),
    optional = setOf(
      "fallbackModels",
      "tools",
      "skills",
      "workspace",
      "maxTokens",
      "mcpServers",
      "plugins",
      "providers",
      "swarm",
    ),
  )
  WireRules.requireNonempty(raw.requiredString("name"), "MobileAgentConfig.name")
  WireRules.requireNonempty(raw.requiredString("model"), "MobileAgentConfig.model")
  raw.requiredString("systemPrompt")
  listOf("fallbackModels", "tools", "mcpServers", "plugins", "providers").forEach { field ->
    raw.optionalNonNull(field)?.arrayFor("MobileAgentConfig.$field")?.forEach { node ->
      WireRules.requireNonempty(node.stringFor("MobileAgentConfig.$field[]"), field)
    }
  }
  raw.optionalNonNull("workspace")?.stringFor("MobileAgentConfig.workspace")
  raw.optionalNonNull("maxTokens")?.longFor("MobileAgentConfig.maxTokens")?.let {
    WireRules.requirePositive(it, "MobileAgentConfig.maxTokens")
  }
  raw.optionalNonNull("skills")?.objectFor("AgentSkills")?.let { skills ->
    skills.shape(required = emptySet(), optional = setOf("paths", "urls"))
    listOf("paths", "urls").forEach { field ->
      skills.optionalNonNull(field)?.arrayFor("AgentSkills.$field")?.forEach { node ->
        WireRules.requireNonempty(node.stringFor("AgentSkills.$field[]"), field)
      }
    }
  }
  raw.optionalNonNull("swarm")?.objectFor("AgentSwarm")?.let { swarm ->
    swarm.shape(
      required = emptySet(),
      optional = setOf(
        "enabled",
        "maxConcurrentWorkers",
        "maxWorkersPerRun",
        "maxSteersPerWorker",
        "maxRunSeconds",
        "allowedModels",
      ),
    )
    swarm.optionalNonNull("enabled")?.booleanFor("AgentSwarm.enabled")
    listOf("maxConcurrentWorkers", "maxWorkersPerRun", "maxRunSeconds").forEach { field ->
      swarm.optionalNonNull(field)?.longFor("AgentSwarm.$field")?.let {
        WireRules.requirePositive(it, "AgentSwarm.$field")
      }
    }
    swarm.optionalNonNull("maxSteersPerWorker")?.longFor("AgentSwarm.maxSteersPerWorker")?.let {
      WireRules.requireNonnegative(it, "AgentSwarm.maxSteersPerWorker")
    }
    swarm.optionalNonNull("allowedModels")?.arrayFor("AgentSwarm.allowedModels")?.forEach { node ->
      WireRules.requireNonempty(node.stringFor("AgentSwarm.allowedModels[]"), "allowedModels")
    }
  }
}

private fun validateCreateMobileAgentRequest(value: JsonElement) {
  val raw = value.objectFor("CreateMobileAgentRequest")
  raw.shape(setOf("name", "model", "systemPrompt"))
  WireRules.requireNonempty(raw.requiredString("name"), "CreateMobileAgentRequest.name")
  WireRules.requireNonempty(raw.requiredString("model"), "CreateMobileAgentRequest.model")
  raw.requiredString("systemPrompt")
}

private fun validateUpdateMobileAgentRequest(value: JsonElement) {
  val raw = value.objectFor("UpdateMobileAgentRequest")
  raw.shape(required = emptySet(), optional = setOf("model", "systemPrompt"))
  require(raw.isNotEmpty())
  raw.optionalNonNull("model")?.stringFor("UpdateMobileAgentRequest.model")?.let {
    WireRules.requireNonempty(it, "UpdateMobileAgentRequest.model")
  }
  raw.optionalNonNull("systemPrompt")?.stringFor("UpdateMobileAgentRequest.systemPrompt")
}

private fun validateMobileActionResponse(value: JsonElement) {
  val raw = value.objectFor("MobileActionResponse")
  raw.shape(setOf("ok"))
  require(raw.requiredBoolean("ok"))
}

private fun validateMobileSkillList(value: JsonElement) {
  value.arrayFor("MobileSkillList").forEach { node ->
    val raw = node.objectFor("MobileSkill")
    raw.shape(
      required = setOf("name", "description", "source"),
      optional = setOf("trigger", "content"),
    )
    raw.requiredString("name")
    raw.requiredString("description")
    WireRules.requireNonempty(raw.requiredString("source"), "MobileSkill.source")
    raw.optionalNonNull("trigger")?.stringFor("MobileSkill.trigger")
    raw.optionalNonNull("content")?.stringFor("MobileSkill.content")
  }
}

private fun validateMemoryInfoList(value: JsonElement) {
  value.arrayFor("MemoryInfoList").forEach { validateMemoryInfo(it, includeSize = true) }
}

private fun validateMemoryRecord(value: JsonElement) {
  validateMemoryInfo(value, includeSize = false)
}

private fun validateMemoryInfo(value: JsonElement, includeSize: Boolean) {
  val raw = value.objectFor(if (includeSize) "MobileMemoryInfo" else "MobileMemoryRecord")
  val required = mutableSetOf(
    "name",
    "description",
    "type",
    "source",
    "createdAt",
    "updatedAt",
  )
  required += if (includeSize) "size" else "content"
  raw.shape(required)
  WireRules.requireNonempty(raw.requiredString("name"), "MobileMemory.name")
  raw.requiredString("description")
  WireRules.requireMemoryType(raw.requiredString("type"), "MobileMemory.type")
  WireRules.requireMemorySource(raw.requiredString("source"), "MobileMemory.source")
  WireRules.requireIsoDate(raw.requiredString("createdAt"), "MobileMemory.createdAt")
  WireRules.requireIsoDate(raw.requiredString("updatedAt"), "MobileMemory.updatedAt")
  if (includeSize) {
    WireRules.requireNonnegative(raw.requiredLong("size"), "MobileMemory.size")
  } else {
    raw.requiredString("content")
  }
}

private fun validateMemoryDeleteResponse(value: JsonElement) {
  val raw = value.objectFor("MobileMemoryDeleteResponse")
  raw.shape(setOf("name"))
  WireRules.requireNonempty(raw.requiredString("name"), "MobileMemoryDeleteResponse.name")
}

private fun validateMemoryNotFoundError(value: JsonElement) {
  val raw = value.objectFor("MemoryNotFoundError")
  raw.shape(setOf("error"))
  WireRules.requireNonempty(raw.requiredString("error"), "MemoryNotFoundError.error")
}

private fun validateMobileModelsResponse(value: JsonElement) {
  val raw = value.objectFor("MobileModelsResponse")
  raw.shape(setOf("models", "source", "errors", "fetchedAt", "supportedModelsReviewedAt"))
  raw.requiredArray("models").forEach { node ->
    val model = node.objectFor("MobileModel")
    model.shape(setOf("value", "label", "provider"))
    WireRules.requireModelIdentifier(model.requiredString("value"), "MobileModel.value")
    WireRules.requireNonempty(model.requiredString("label"), "MobileModel.label")
    WireRules.requireNonempty(model.requiredString("provider"), "MobileModel.provider")
  }
  require(raw.requiredString("source") in setOf("live", "bootstrap"))
  raw.requiredObject("errors").values.forEach { it.stringFor("MobileModelsResponse.errors[]") }
  WireRules.requireRfc3339(raw.requiredString("fetchedAt"), "MobileModelsResponse.fetchedAt")
  val reviewedAt = raw.requiredString("supportedModelsReviewedAt")
  if (reviewedAt != "unreviewed") {
    WireRules.requireIsoDate(reviewedAt, "MobileModelsResponse.supportedModelsReviewedAt")
  }
}

private fun validateMobileApiError(value: JsonElement) {
  val raw = value.objectFor("MobileApiError")
  raw.shape(
    required = setOf("code", "error", "retryable"),
    optional = setOf("details"),
  )
  WireRules.requireApiErrorCode(raw.requiredString("code"), "MobileApiError.code")
  WireRules.requireNonempty(raw.requiredString("error"), "MobileApiError.error")
  raw.requiredBoolean("retryable")
  raw.optionalNonNull("details")?.objectFor("MobileApiError.details")
}

private fun validateConversationBusyError(value: JsonElement) {
  validateMobileApiError(value)
  val raw = value.objectFor("ConversationBusyError")
  require(raw.requiredString("code") == "conversation_busy")
  val details = raw.requiredObject("details")
  details.shape(setOf("activeTurnId"))
  WireRules.requireNonempty(
    details.requiredString("activeTurnId"),
    "ConversationBusyError.details.activeTurnId",
  )
}

private fun validateConversationDefaults(value: JsonElement) {
  val raw = value.objectFor("ConversationDefaults")
  raw.shape(setOf("defaultConversationTitle"))
  require(
    raw.requiredString("defaultConversationTitle") ==
      app.dash.core.contracts.ConversationDefaults.DEFAULT_CONVERSATION_TITLE,
  )
}

private fun validateConversationSummary(value: JsonElement) {
  val raw = value.objectFor("ConversationSummary")
  raw.shape(
    required = setOf(
      "id",
      "agentId",
      "agentName",
      "title",
      "revision",
      "status",
      "activeTurnId",
      "owningIssueId",
      "projectId",
      "lastSeq",
      "lastMessagePreview",
      "createdAt",
      "updatedAt",
    ),
    optional = setOf("deletedAt"),
  )
  WireRules.requireUuid(raw.requiredString("id"), "ConversationSummary.id")
  WireRules.requireNonempty(raw.requiredString("agentId"), "ConversationSummary.agentId")
  WireRules.requireNonempty(raw.requiredString("agentName"), "ConversationSummary.agentName")
  raw.requiredString("title")
  WireRules.requirePositive(raw.requiredLong("revision"), "ConversationSummary.revision")
  require(
    raw.requiredString("status") in setOf("idle", "running", "interrupted", "archived", "deleted"),
  )
  raw.requiredNullableString("activeTurnId")?.let {
    WireRules.requireUuid(it, "ConversationSummary.activeTurnId")
  }
  raw.requiredNullableString("owningIssueId")
  raw.requiredNullableString("projectId")
  WireRules.requireNonnegative(raw.requiredLong("lastSeq"), "ConversationSummary.lastSeq")
  raw.requiredNullableString("lastMessagePreview")
  WireRules.requireRfc3339(raw.requiredString("createdAt"), "ConversationSummary.createdAt")
  WireRules.requireRfc3339(raw.requiredString("updatedAt"), "ConversationSummary.updatedAt")
  raw.optionalNonNull("deletedAt")?.stringFor("ConversationSummary.deletedAt")?.let {
    WireRules.requireRfc3339(it, "ConversationSummary.deletedAt")
  }
}

private fun validateConversationPage(value: JsonElement) {
  val raw = value.objectFor("ConversationPage")
  raw.shape(setOf("items", "nextCursor"))
  raw.requiredArray("items").forEach(::validateConversationSummary)
  raw.requiredNullableString("nextCursor")
}

private fun validateConversationMessagePage(value: JsonElement) {
  val raw = value.objectFor("ConversationMessagePage")
  raw.shape(setOf("items", "nextCursor", "throughSeq"))
  raw.requiredArray("items").forEach(::validateConversationMessage)
  raw.requiredNullableString("nextCursor")
  WireRules.requireNonnegative(raw.requiredLong("throughSeq"), "ConversationMessagePage.throughSeq")
}

private fun validateConversationMessage(value: JsonElement) {
  val raw = value.objectFor("ConversationMessage")
  raw.shape(
    setOf(
      "id",
      "conversationId",
      "turnId",
      "ordinal",
      "role",
      "status",
      "content",
      "createdAt",
      "updatedAt",
    ),
  )
  WireRules.requireUuid(raw.requiredString("id"), "ConversationMessage.id")
  WireRules.requireUuid(raw.requiredString("conversationId"), "ConversationMessage.conversationId")
  WireRules.requireUuid(raw.requiredString("turnId"), "ConversationMessage.turnId")
  WireRules.requirePositive(raw.requiredLong("ordinal"), "ConversationMessage.ordinal")
  require(raw.requiredString("role") in setOf("user", "assistant"))
  require(
    raw.requiredString("status") in
      setOf("accepted", "streaming", "completed", "cancelled", "failed", "interrupted"),
  )
  validateConversationContent(raw.getValueOrThrow("content"))
  WireRules.requireRfc3339(raw.requiredString("createdAt"), "ConversationMessage.createdAt")
  WireRules.requireRfc3339(raw.requiredString("updatedAt"), "ConversationMessage.updatedAt")
}

private fun validateConversationContent(value: JsonElement) {
  val raw = value.objectFor("ConversationContent")
  val type = WireRules.requireNonempty(raw.requiredString("type"), "ConversationContent.type")
  when (type) {
    "user" -> {
      raw.shape(required = setOf("type", "text"), optional = setOf("images"))
      raw.requiredString("text")
      raw.optionalNonNull("images")?.arrayFor("ConversationContent.User.images")?.forEach(
        ::validateMobileImage,
      )
    }
    "assistant" -> {
      raw.shape(setOf("type", "events"))
      raw.requiredArray("events").forEach { event ->
        ContractJson.strict.decodeFromJsonElement(AgentEvent.serializer(), event)
      }
    }
    "notice" -> {
      raw.shape(setOf("type", "kind", "text"))
      WireRules.requireNonempty(raw.requiredString("kind"), "ConversationContent.Notice.kind")
      raw.requiredString("text")
    }
  }
}

private fun validateMobileImage(value: JsonElement) {
  val raw = value.objectFor("MobileImage")
  raw.shape(setOf("mediaType", "data"))
  require(raw.requiredString("mediaType") in setOf("image/jpeg", "image/png", "image/gif", "image/webp"))
  WireRules.requireNonempty(raw.requiredString("data"), "MobileImage.data")
}

private fun validateConversationCreateRequest(value: JsonElement) {
  val raw = value.objectFor("ConversationCreateRequest")
  raw.shape(
    required = setOf("agentId", "requestId"),
    optional = setOf("title", "owningIssueId", "projectId"),
  )
  WireRules.requireNonempty(raw.requiredString("agentId"), "ConversationCreateRequest.agentId")
  WireRules.requireNonempty(raw.requiredString("requestId"), "ConversationCreateRequest.requestId")
  raw.optionalNonNull("title")?.stringFor("ConversationCreateRequest.title")
  listOf("owningIssueId", "projectId").forEach { field ->
    raw.optionalNonNull(field)?.stringFor("ConversationCreateRequest.$field")?.let {
      WireRules.requireNonempty(it, "ConversationCreateRequest.$field")
    }
  }
}

private fun validateConversationPatchRequest(value: JsonElement) {
  val raw = value.objectFor("ConversationPatchRequest")
  raw.shape(
    required = emptySet(),
    optional = setOf("title", "owningIssueId", "projectId"),
  )
  require(raw.isNotEmpty())
  raw.optionalNonNull("title")?.stringFor("ConversationPatchRequest.title")
  listOf("owningIssueId", "projectId").forEach { field ->
    raw[field]?.takeUnless { it === JsonNull }?.stringFor("ConversationPatchRequest.$field")
  }
}

private fun validateRevisionConflictError(value: JsonElement) {
  validateMobileApiError(value)
  val raw = value.objectFor("RevisionConflictError")
  require(raw.requiredString("code") == "revision_conflict")
  val details = raw.requiredObject("details")
  details.shape(setOf("current"))
  validateConversationSummary(details.getValueOrThrow("current"))
}

private fun validateChatSend(value: JsonElement) {
  validateMessageFrame(value, canonical = true)
}

private fun validateMobileWsClientFrame(value: JsonElement) {
  when (value.objectFor("MobileWsClientFrame").requiredString("type")) {
    "message" -> validateMessageFrame(value, canonical = false)
    "resume" -> validateChatResume(value)
    "answer" -> validateChatAnswer(value)
    "cancel" -> validateChatCancel(value)
    else -> throw IllegalArgumentException("unsupported client frame type")
  }
}

private fun validateMessageFrame(value: JsonElement, canonical: Boolean) {
  val raw = value.objectFor(if (canonical) "ChatSend" else "MobileWsMessageFrame")
  val required = mutableSetOf("type", "id", "agentId", "channelId", "conversationId", "text")
  if (canonical) required += "resumable"
  raw.shape(
    required = required,
    optional = setOf("location", "images", "streamingBehavior", "resumable"),
  )
  require(raw.requiredString("type") == "message")
  WireRules.requireUuid(raw.requiredString("id"), "ChatMessage.id")
  WireRules.requireNonempty(raw.requiredString("agentId"), "ChatMessage.agentId")
  WireRules.requireNonempty(raw.requiredString("channelId"), "ChatMessage.channelId")
  WireRules.requireUuid(raw.requiredString("conversationId"), "ChatMessage.conversationId")
  raw.requiredString("text")
  raw.optionalNonNull("location")?.let(::validateMobileClientLocation)
  raw.optionalNonNull("images")?.arrayFor("ChatMessage.images")?.forEach(::validateMobileImage)
  raw.optionalNonNull("streamingBehavior")?.stringFor("ChatMessage.streamingBehavior")?.let {
    require(it in setOf("steer", "followUp"))
  }
  raw.optionalNonNull("resumable")?.booleanFor("ChatMessage.resumable")?.let {
    if (canonical) require(it)
  }
}

private fun validateMobileClientLocation(value: JsonElement) {
  val raw = value.objectFor("MobileClientLocation")
  raw.shape(
    required = setOf("timezone", "utcOffsetMinutes", "locale"),
    optional = setOf("region", "precise"),
  )
  require(raw.requiredString("timezone").length in 1..200)
  require(raw.requiredLong("utcOffsetMinutes") in -840..840)
  require(raw.requiredString("locale").length in 1..200)
  raw.optionalNonNull("region")?.stringFor("MobileClientLocation.region")?.let {
    require(it.length == 2)
  }
  raw.optionalNonNull("precise")?.let(::validateMobilePreciseLocation)
}

private fun validateMobilePreciseLocation(value: JsonElement) {
  val raw = value.objectFor("MobilePreciseLocation")
  raw.shape(
    required = setOf("latitude", "longitude", "accuracyMeters", "capturedAt"),
    optional = setOf("place"),
  )
  require(raw.requiredDouble("latitude") in -90.0..90.0)
  require(raw.requiredDouble("longitude") in -180.0..180.0)
  require(raw.requiredDouble("accuracyMeters") >= 0.0)
  WireRules.requireRfc3339(raw.requiredString("capturedAt"), "MobilePreciseLocation.capturedAt")
  raw.optionalNonNull("place")?.stringFor("MobilePreciseLocation.place")?.let {
    require(it.length <= 200)
  }
}

private fun validateChatResume(value: JsonElement) {
  val raw = value.objectFor("ChatResume")
  raw.shape(setOf("type", "id", "agentId", "conversationId", "sinceSeq"))
  require(raw.requiredString("type") == "resume")
  WireRules.requireUuid(raw.requiredString("id"), "ChatResume.id")
  WireRules.requireNonempty(raw.requiredString("agentId"), "ChatResume.agentId")
  WireRules.requireUuid(raw.requiredString("conversationId"), "ChatResume.conversationId")
  WireRules.requireNonnegative(raw.requiredLong("sinceSeq"), "ChatResume.sinceSeq")
}

private fun validateChatAnswer(value: JsonElement) {
  val raw = value.objectFor("ChatAnswer")
  raw.shape(setOf("type", "id", "questionId", "answer"))
  require(raw.requiredString("type") == "answer")
  WireRules.requireUuid(raw.requiredString("id"), "ChatAnswer.id")
  WireRules.requireNonempty(raw.requiredString("questionId"), "ChatAnswer.questionId")
  raw.requiredString("answer")
}

private fun validateChatCancel(value: JsonElement) {
  val raw = value.objectFor("ChatCancel")
  raw.shape(setOf("type", "id"))
  require(raw.requiredString("type") == "cancel")
  WireRules.requireUuid(raw.requiredString("id"), "ChatCancel.id")
}

private fun validateMobileWsServerFrame(value: JsonElement) {
  when (value.objectFor("MobileWsServerFrame").requiredString("type")) {
    "accepted" -> validateChatAccepted(value)
    "event" -> validateEventFrame(value, canonical = false)
    "done" -> validateDoneFrame(value, canonical = false)
    "error" -> validateErrorFrame(value, canonical = false)
    else -> throw IllegalArgumentException("unsupported server frame type")
  }
}

private fun validateChatAccepted(value: JsonElement) {
  val raw = value.objectFor("ChatAccepted")
  raw.shape(
    setOf("type", "id", "conversationId", "userMessageId", "assistantMessageId", "revision", "seq"),
  )
  require(raw.requiredString("type") == "accepted")
  listOf("id", "conversationId", "userMessageId", "assistantMessageId").forEach { field ->
    WireRules.requireUuid(raw.requiredString(field), "ChatAccepted.$field")
  }
  WireRules.requirePositive(raw.requiredLong("revision"), "ChatAccepted.revision")
  WireRules.requirePositive(raw.requiredLong("seq"), "ChatAccepted.seq")
}

private fun validateChatEvent(value: JsonElement) {
  validateEventFrame(value, canonical = true)
}

private fun validateEventFrame(value: JsonElement, canonical: Boolean) {
  val raw = value.objectFor(if (canonical) "ChatEvent" else "MobileWsEventFrame")
  val required = mutableSetOf("type", "id", "event")
  if (canonical) required += setOf("conversationId", "seq")
  raw.shape(required = required, optional = setOf("conversationId", "seq"))
  require(raw.requiredString("type") == "event")
  WireRules.requireUuid(raw.requiredString("id"), "ChatEvent.id")
  raw.optionalNonNull("conversationId")?.stringFor("ChatEvent.conversationId")?.let {
    WireRules.requireUuid(it, "ChatEvent.conversationId")
  }
  raw.optionalNonNull("seq")?.longFor("ChatEvent.seq")?.let {
    WireRules.requirePositive(it, "ChatEvent.seq")
  }
  ContractJson.strict.decodeFromJsonElement(AgentEvent.serializer(), raw.getValueOrThrow("event"))
}

private fun validateChatDone(value: JsonElement) {
  validateDoneFrame(value, canonical = true)
}

private fun validateDoneFrame(value: JsonElement, canonical: Boolean) {
  val raw = value.objectFor(if (canonical) "ChatDone" else "MobileWsDoneFrame")
  val required = mutableSetOf("type", "id")
  if (canonical) required += setOf("conversationId", "seq", "outcome")
  raw.shape(required = required, optional = setOf("conversationId", "seq", "outcome"))
  require(raw.requiredString("type") == "done")
  WireRules.requireUuid(raw.requiredString("id"), "ChatDone.id")
  raw.optionalNonNull("conversationId")?.stringFor("ChatDone.conversationId")?.let {
    WireRules.requireUuid(it, "ChatDone.conversationId")
  }
  raw.optionalNonNull("seq")?.longFor("ChatDone.seq")?.let {
    WireRules.requirePositive(it, "ChatDone.seq")
  }
  raw.optionalNonNull("outcome")?.stringFor("ChatDone.outcome")?.let {
    require(it in setOf("completed", "cancelled"))
  }
}

private fun validateChatError(value: JsonElement) {
  validateErrorFrame(value, canonical = true)
}

private fun validateErrorFrame(value: JsonElement, canonical: Boolean) {
  val raw = value.objectFor(if (canonical) "ChatError" else "MobileWsErrorFrame")
  val required = mutableSetOf("type", "id", "error")
  if (canonical) required += setOf("conversationId", "seq")
  raw.shape(
    required = required,
    optional = setOf("conversationId", "seq", "code", "retryable", "activeTurnId"),
  )
  require(raw.requiredString("type") == "error")
  WireRules.requireUuid(raw.requiredString("id"), "ChatError.id")
  raw.optionalNonNull("conversationId")?.stringFor("ChatError.conversationId")?.let {
    WireRules.requireUuid(it, "ChatError.conversationId")
  }
  raw.optionalNonNull("seq")?.longFor("ChatError.seq")?.let {
    WireRules.requirePositive(it, "ChatError.seq")
  }
  WireRules.requireNonempty(raw.requiredString("error"), "ChatError.error")
  raw.optionalNonNull("code")?.stringFor("ChatError.code")?.let {
    WireRules.requireApiErrorCode(it, "ChatError.code")
  }
  raw.optionalNonNull("retryable")?.booleanFor("ChatError.retryable")
  raw.optionalNonNull("activeTurnId")?.stringFor("ChatError.activeTurnId")?.let {
    WireRules.requireNonempty(it, "ChatError.activeTurnId")
  }
}

private fun validateReplayPage(value: JsonElement) {
  val raw = value.objectFor("ReplayPage")
  raw.shape(setOf("entries"))
  var previous = 0L
  raw.requiredArray("entries").forEach { node ->
    val entry = node.objectFor("ReplayEntry")
    entry.shape(setOf("seq", "msgId", "agentId", "conversationId", "timestamp", "payload"))
    val seq = WireRules.requirePositive(entry.requiredLong("seq"), "ReplayEntry.seq")
    require(seq > previous) { "ReplayPage entries must be strictly increasing" }
    previous = seq
    WireRules.requireNonempty(entry.requiredString("msgId"), "ReplayEntry.msgId")
    WireRules.requireNonempty(entry.requiredString("agentId"), "ReplayEntry.agentId")
    WireRules.requireUuid(entry.requiredString("conversationId"), "ReplayEntry.conversationId")
    WireRules.requireRfc3339(entry.requiredString("timestamp"), "ReplayEntry.timestamp")
    validateReplayPayload(entry.getValueOrThrow("payload"))
  }
}

private fun validateReplayPayload(value: JsonElement) {
  when (value.objectFor("ReplayPayload").requiredString("type")) {
    "accepted" -> validateReplayAccepted(value)
    "event" -> validateReplayEvent(value)
    "done" -> validateReplayDone(value)
    "error" -> validateReplayError(value)
    else -> throw IllegalArgumentException("unsupported replay payload type")
  }
}

private fun validateReplayAccepted(value: JsonElement) {
  val raw = value.objectFor("ReplayPayload.Accepted")
  raw.shape(setOf("type", "userMessageId", "assistantMessageId", "revision"))
  require(raw.requiredString("type") == "accepted")
  WireRules.requireUuid(raw.requiredString("userMessageId"), "ReplayPayload.userMessageId")
  WireRules.requireUuid(raw.requiredString("assistantMessageId"), "ReplayPayload.assistantMessageId")
  WireRules.requirePositive(raw.requiredLong("revision"), "ReplayPayload.revision")
}

private fun validateReplayEvent(value: JsonElement) {
  val raw = value.objectFor("ReplayPayload.Event")
  raw.shape(setOf("type", "event"))
  require(raw.requiredString("type") == "event")
  ContractJson.strict.decodeFromJsonElement(AgentEvent.serializer(), raw.getValueOrThrow("event"))
}

private fun validateReplayDone(value: JsonElement) {
  val raw = value.objectFor("ReplayPayload.Done")
  raw.shape(required = setOf("type"), optional = setOf("outcome"))
  require(raw.requiredString("type") == "done")
  raw.optionalNonNull("outcome")?.stringFor("ReplayPayload.outcome")?.let {
    require(it in setOf("completed", "cancelled"))
  }
}

private fun validateReplayError(value: JsonElement) {
  val raw = value.objectFor("ReplayPayload.Error")
  raw.shape(required = setOf("type", "error"), optional = setOf("code", "retryable"))
  require(raw.requiredString("type") == "error")
  WireRules.requireNonempty(raw.requiredString("error"), "ReplayPayload.error")
  raw.optionalNonNull("code")?.stringFor("ReplayPayload.code")?.let {
    WireRules.requireApiErrorCode(it, "ReplayPayload.code")
  }
  raw.optionalNonNull("retryable")?.booleanFor("ReplayPayload.retryable")
}

private fun validateConversationChanged(value: JsonElement) {
  validateInvalidation(value, "conversation:changed")
}

private fun validateConversationDeleted(value: JsonElement) {
  validateInvalidation(value, "conversation:deleted")
}

private fun validateInvalidation(value: JsonElement, type: String) {
  val raw = value.objectFor("GatewayInvalidation")
  raw.shape(setOf("type", "conversationId", "revision"))
  require(raw.requiredString("type") == type)
  WireRules.requireUuid(raw.requiredString("conversationId"), "GatewayInvalidation.conversationId")
  WireRules.requirePositive(raw.requiredLong("revision"), "GatewayInvalidation.revision")
}

private fun JsonElement.objectFor(context: String): JsonObject = this as? JsonObject
  ?: throw IllegalArgumentException("$context must be an object")

private fun JsonElement.arrayFor(context: String): JsonArray = this as? JsonArray
  ?: throw IllegalArgumentException("$context must be an array")

private fun JsonElement.stringFor(context: String): String =
  (this as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content
    ?: throw IllegalArgumentException("$context must be a string")

private fun JsonElement.longFor(context: String): Long =
  (this as? JsonPrimitive)?.takeUnless(JsonPrimitive::isString)?.longOrNull
    ?: throw IllegalArgumentException("$context must be an integer")

private fun JsonElement.doubleFor(context: String): Double =
  (this as? JsonPrimitive)?.takeUnless(JsonPrimitive::isString)?.doubleOrNull
    ?: throw IllegalArgumentException("$context must be a number")

private fun JsonElement.booleanFor(context: String): Boolean =
  (this as? JsonPrimitive)?.takeUnless(JsonPrimitive::isString)?.booleanOrNull
    ?: throw IllegalArgumentException("$context must be a boolean")

private fun JsonObject.shape(required: Set<String>, optional: Set<String> = emptySet()) {
  require(keys.containsAll(required)) { "missing required keys ${required - keys}" }
  require(keys.all { it in required || it in optional }) { "unexpected keys ${keys - required - optional}" }
}

private fun JsonObject.requiredString(field: String): String =
  getValueOrThrow(field).stringFor(field)

private fun JsonObject.requiredLong(field: String): Long = getValueOrThrow(field).longFor(field)

private fun JsonObject.requiredDouble(field: String): Double =
  getValueOrThrow(field).doubleFor(field)

private fun JsonObject.requiredBoolean(field: String): Boolean =
  getValueOrThrow(field).booleanFor(field)

private fun JsonObject.requiredArray(field: String): JsonArray =
  getValueOrThrow(field).arrayFor(field)

private fun JsonObject.requiredObject(field: String): JsonObject =
  getValueOrThrow(field).objectFor(field)

private fun JsonObject.requiredNullableString(field: String): String? {
  require(containsKey(field)) { "$field is required" }
  val value = getValue(field)
  return if (value === JsonNull) null else value.stringFor(field)
}

private fun JsonObject.optionalNonNull(field: String): JsonElement? {
  val value = get(field) ?: return null
  require(value !== JsonNull) { "$field must not be null" }
  return value
}

private fun JsonObject.getValueOrThrow(field: String): JsonElement = get(field)?.takeUnless {
  it === JsonNull
} ?: throw IllegalArgumentException("$field is required and must not be null")
