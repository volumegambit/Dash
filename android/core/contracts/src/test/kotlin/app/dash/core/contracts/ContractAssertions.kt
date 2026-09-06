package app.dash.core.contracts

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

object ContractAssertions {
  private val pairingHost = Regex("""^(?![A-Za-z][A-Za-z0-9+.-]*:)[^\s/\\?#@%]+$""")
  private val certificateSha256 = Regex("""^[A-Fa-f0-9]{64}$""")

  fun assertValid(document: WireDocument, schema: String, value: JsonElement) {
    assertCanonicalAgentEvents(value)
    when (document to schema) {
      WireDocument.OpenApi to "PairingPayload" -> assertPairingFixture(value)
      WireDocument.OpenApi to "MobileHealth" -> decode(WireContracts.MobileHealth, value)
      WireDocument.OpenApi to "GatewayIdentity" -> decode(WireContracts.GatewayIdentity, value)
      WireDocument.OpenApi to "WsTicketResponse" -> decode(WireContracts.WsTicketResponse, value)
      WireDocument.OpenApi to "MobileAgent" -> decode(WireContracts.MobileAgent, value)
      WireDocument.OpenApi to "MobileAgentList" -> decode(WireContracts.MobileAgentList, value)
      WireDocument.OpenApi to "CreateMobileAgentRequest" ->
        decode(WireContracts.CreateMobileAgentRequest, value)
      WireDocument.OpenApi to "UpdateMobileAgentRequest" ->
        decode(WireContracts.UpdateMobileAgentRequest, value)
      WireDocument.OpenApi to "MobileActionResponse" ->
        decode(WireContracts.MobileActionResponse, value)
      WireDocument.OpenApi to "MobileSkillList" -> {
        val rows = value as? JsonArray
          ?: throw IllegalArgumentException("MobileSkillList must be an array")
        require(rows.all { row ->
          row.jsonObject.getValue("source").jsonPrimitive.content in
            setOf("managed", "agent", "remote", "plugin")
        })
        decode(WireContracts.MobileSkillList, value)
      }
      WireDocument.OpenApi to "MemoryInfoList" -> decode(WireContracts.MemoryInfoList, value)
      WireDocument.OpenApi to "MemoryRecord" -> decode(WireContracts.MemoryRecord, value)
      WireDocument.OpenApi to "MemoryDeleteResponse" ->
        decode(WireContracts.MemoryDeleteResponse, value)
      WireDocument.OpenApi to "MemoryNotFoundError" ->
        decode(WireContracts.MemoryNotFoundError, value)
      WireDocument.OpenApi to "MobileModelsResponse" ->
        decode(WireContracts.MobileModelsResponse, value)
      WireDocument.OpenApi to "MobileApiError" -> decode(WireContracts.MobileApiError, value)
      WireDocument.OpenApi to "ConversationBusyError" ->
        decode(WireContracts.ConversationBusyError, value)
      WireDocument.OpenApi to "ConversationDefaults" ->
        decode(WireContracts.ConversationDefaults, value)
      WireDocument.OpenApi to "ConversationSummary" ->
        decode(WireContracts.ConversationSummary, value)
      WireDocument.OpenApi to "ConversationPage" -> decode(WireContracts.ConversationPage, value)
      WireDocument.OpenApi to "ConversationMessagePage" -> {
        assertCanonicalConversationContent(value)
        decode(WireContracts.ConversationMessagePage, value)
      }
      WireDocument.OpenApi to "ConversationCreateRequest" ->
        decode(WireContracts.ConversationCreateRequest, value)
      WireDocument.OpenApi to "ConversationPatchRequest" ->
        decode(WireContracts.ConversationPatchRequest, value)
      WireDocument.OpenApi to "RevisionConflictError" ->
        decode(WireContracts.RevisionConflictError, value)
      WireDocument.OpenApi to "ReplayPage" -> decode(WireContracts.ReplayPage, value)
      WireDocument.OpenApi to "ConversationChangedEvent" ->
        decode(WireContracts.ConversationChangedEvent, value)
      WireDocument.OpenApi to "ConversationDeletedEvent" ->
        decode(WireContracts.ConversationDeletedEvent, value)
      WireDocument.ChatWs to "ChatSend" -> decode(WireContracts.ChatSend, value)
      WireDocument.ChatWs to "ChatResume" -> decode(WireContracts.ChatResume, value)
      WireDocument.ChatWs to "ChatAnswer" -> decode(WireContracts.ChatAnswer, value)
      WireDocument.ChatWs to "ChatCancel" -> decode(WireContracts.ChatCancel, value)
      WireDocument.ChatWs to "ChatAccepted" -> decode(WireContracts.ChatAccepted, value)
      WireDocument.ChatWs to "ChatEvent" -> decode(WireContracts.ChatEvent, value)
      WireDocument.ChatWs to "ChatDone" -> decode(WireContracts.ChatDone, value)
      WireDocument.ChatWs to "ChatError" -> decode(WireContracts.ChatError, value)
      WireDocument.ChatWs to "MobileWsClientFrame" ->
        decode(WireContracts.MobileWsClientFrame, value)
      WireDocument.ChatWs to "MobileWsServerFrame" ->
        decode(WireContracts.MobileWsServerFrame, value)
      WireDocument.ChatWs to "MobileWsFrame" -> assertMobileWsFrame(value)
      else -> throw IllegalArgumentException("Unasserted manifest schema: $schema")
    }
  }

  private fun <T> decode(contract: WireContract<T>, value: JsonElement) {
    WireContractValidator.decodeRuntime(contract, value)
  }

  private fun assertCanonicalConversationContent(value: JsonElement) {
    val page = value.jsonObject
    val items = page.getValue("items") as? JsonArray
      ?: throw IllegalArgumentException("ConversationMessagePage.items must be an array")
    items.forEach { message ->
      val content = message.jsonObject.getValue("content").jsonObject
      when (content.getValue("type").jsonPrimitive.content) {
        "user", "assistant" -> Unit
        "notice" -> require(
          content.getValue("kind").jsonPrimitive.content in setOf("skill_learned", "memory_saved"),
        )
        else -> throw IllegalArgumentException("unknown canonical conversation content")
      }
    }
  }

  private fun assertMobileWsFrame(value: JsonElement) {
    when (value.jsonObject.getValue("type").jsonPrimitive.content) {
      "message", "resume", "answer", "cancel" -> decode(WireContracts.MobileWsClientFrame, value)
      "accepted", "event", "done", "error" -> decode(WireContracts.MobileWsServerFrame, value)
      else -> throw IllegalArgumentException("unsupported MobileWsFrame type")
    }
  }

  private fun assertPairingFixture(value: JsonElement) {
    val raw = value as? JsonObject
      ?: throw IllegalArgumentException("PairingPayload must be an object")
    val version = raw.requiredInt("v")
    val host = raw.requiredString("host")
    val managementToken = raw.requiredString("mgmtToken").trim()
    val chatToken = raw.requiredString("chatToken").trim()
    require(raw.requiredBoolean("secure"))
    require(pairingHost.matches(host))
    require(managementToken.isNotEmpty() && managementToken == chatToken)
    when (version) {
      2 -> require(raw.requiredString("relayCredential").isNotBlank())
      3 -> {
        val managementPort = raw.requiredInt("mgmtPort")
        val chatPort = raw.requiredInt("chatPort")
        require(managementPort in 1..65_535 && chatPort == managementPort)
        require(certificateSha256.matches(raw.requiredString("tlsCertificateSha256")))
      }
      else -> throw IllegalArgumentException("unsupported pairing version")
    }
  }

  private fun assertCanonicalAgentEvents(value: JsonElement) {
    when (value) {
      is JsonArray -> value.forEach(::assertCanonicalAgentEvents)
      is JsonObject -> {
        val type = (value["type"] as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content
        if (type == "event") value["event"]?.let(::assertCanonicalAgentEvent)
        if (type == "assistant") {
          (value["events"] as? JsonArray)?.forEach(::assertCanonicalAgentEvent)
        }
        value.values.forEach(::assertCanonicalAgentEvents)
      }
      else -> Unit
    }
  }

  private fun assertCanonicalAgentEvent(value: JsonElement) {
    val event = value as? JsonObject ?: return
    when ((event["type"] as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content) {
      "text_delta" -> {
        require(event.keys == setOf("type", "text"))
        event.requiredString("text")
      }
      "question" -> {
        require(event.keys == setOf("type", "id", "question", "options"))
        event.requiredString("id")
        event.requiredString("question")
        val options = event["options"] as? JsonArray
          ?: throw IllegalArgumentException("question.options must be an array")
        require(options.all { it is JsonPrimitive && it.isString })
      }
      "response" -> {
        require(event.keys == setOf("type", "content", "usage"))
        event.requiredString("content")
        val usage = event["usage"] as? JsonObject
          ?: throw IllegalArgumentException("response.usage must be an object")
        require(usage.keys == setOf("inputTokens", "outputTokens"))
        usage.requiredInt("inputTokens")
        usage.requiredInt("outputTokens")
      }
    }
  }

  private fun JsonObject.requiredString(field: String): String =
    (get(field) as? JsonPrimitive)
      ?.takeIf(JsonPrimitive::isString)
      ?.content
      ?: throw IllegalArgumentException("$field must be a string")

  private fun JsonObject.requiredInt(field: String): Int =
    (get(field) as? JsonPrimitive)
      ?.takeUnless(JsonPrimitive::isString)
      ?.intOrNull
      ?: throw IllegalArgumentException("$field must be an integer")

  private fun JsonObject.requiredBoolean(field: String): Boolean =
    (get(field) as? JsonPrimitive)
      ?.takeUnless(JsonPrimitive::isString)
      ?.booleanOrNull
      ?: throw IllegalArgumentException("$field must be a boolean")
}
