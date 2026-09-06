package app.dash.core.contracts

import java.lang.reflect.Modifier
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

@Serializable
private data class StrictProbe(val value: String)

class ContractManifestConformanceTest {
  @Test
  fun everyManifestCaseHasTheDeclaredAndroidPolarity() {
    val manifest = FixtureLoader.manifest()
    assertEquals(1, manifest.version)
    assertEquals(manifest.cases.size, manifest.cases.map(FixtureCase::file).toSet().size)
    assertTrue(manifest.cases.all {
      it.document in setOf(WireDocument.OpenApi, WireDocument.ChatWs)
    })
    assertTrue(manifest.cases.any { it.file == "chat-send-with-location.json" && it.valid })
    assertTrue(manifest.cases.any {
      it.file == "invalid/chat-send-latitude-out-of-range.json" && !it.valid
    })
    manifest.cases.forEach { case ->
      FixtureLoader.values(case).forEach { value ->
        if (case.valid) ContractAssertions.assertValid(case.document, case.schema, value)
        else assertThrows(case.file, IllegalArgumentException::class.java) {
          ContractAssertions.assertValid(case.document, case.schema, value)
        }
      }
    }
  }

  @Test
  fun scopeFailureAndClosedDescriptorContracts() {
    assertThrows(SerializationException::class.java) {
      ContractJson.strict.decodeFromString<StrictProbe>("""{"value":"ok","extra":true}""")
    }

    assertThrows(IllegalArgumentException::class.java) { AccountScope("") }
    assertThrows(IllegalArgumentException::class.java) { AccountScope.fromClaims("", "org") }
    assertThrows(IllegalArgumentException::class.java) { GatewayScope(AccountScope("scope"), " ") }
    val first = AccountScope.fromClaims("https://issuer.example", "org-a")
    val second = AccountScope.fromClaims("https://issuer.example", "org-a")
    assertEquals(first, second)
    assertTrue(first.value.matches(Regex("^[A-Za-z0-9_-]{43}$")))
    assertEquals("gateway-a", GatewayScope(first, "gateway-a").gatewayId)

    assertEquals("approval", ApprovalId("approval").value)
    assertEquals("pairing", PairingId("pairing").value)
    assertEquals("signer", SignerId("signer").value)
    assertEquals("approve", ApprovalDecision.Approve.wireValue)
    assertEquals("deny", ApprovalDecision.Deny.wireValue)
    assertEquals("key", SignerPublicIdentity("key").publicKeyBase64Url)
    assertEquals(
      "device",
      ApprovalRequest(
        approvalId = ApprovalId("approval"),
        pairingId = PairingId("pairing"),
        gatewayId = "gateway",
        deviceLabel = "device",
        expiresAtEpochMillis = 123L,
      ).deviceLabel,
    )

    val failures = listOf(
      GatewayFailure.Unauthorized,
      GatewayFailure.Forbidden,
      GatewayFailure.NotFound,
      GatewayFailure.Validation("bad"),
      GatewayFailure.ConversationBusy("turn"),
      GatewayFailure.CapabilityRequired,
      GatewayFailure.UpdateRequired(),
      GatewayFailure.GatewayOffline,
      GatewayFailure.RateLimited(Instant.EPOCH),
      GatewayFailure.Transport("fetch"),
      GatewayFailure.Decoding("MobileHealth"),
      GatewayFailure.Storage("write"),
      GatewayFailure.MutationOutcomeUnknown("resource", "request"),
    )
    assertEquals(13, failures.size)
    assertEquals(1, (failures[6] as GatewayFailure.UpdateRequired).requiredApiVersion)
    assertEquals(Instant.EPOCH, (failures[8] as GatewayFailure.RateLimited).retryAt)
    assertEquals("resource", (failures.last() as GatewayFailure.MutationOutcomeUnknown).resourceId)
    assertTrue(failures.all { it.message?.isNotBlank() == true })

    assertTrue(WireContract::class.java.declaredConstructors.any { Modifier.isPrivate(it.modifiers) })
    assertTrue(WireContract::class.java.constructors.all { it.isSynthetic })
    assertTrue(
      WireContracts::class.java.declaredConstructors.none { Modifier.isPublic(it.modifiers) },
    )
    val validatorMethods = WireContractValidator::class.java.declaredMethods
      .filter { Modifier.isPublic(it.modifiers) }
    assertEquals(
      setOf("assertRuntimeShape", "decodeRuntime", "encodeRuntime"),
      validatorMethods.mapTo(mutableSetOf(), java.lang.reflect.Method::getName),
    )
    assertFalse(validatorMethods.any { method ->
      method.parameterTypes.any { it == String::class.java }
    })
  }

  @Test
  fun integralJsonNumberLexemesMatchSchemaIntegers() {
    val health = decodeJson(
      WireContracts.MobileHealth,
      """{"status":"healthy","startedAt":"2026-01-01T00:00:00Z","pid":1.0,"agents":0e0,"channels":0.000e3,"apiVersion":1e0,"capabilities":[]}""",
    )
    assertEquals(1L, health.pid)
    assertEquals(0L, health.agents)
    assertEquals(0L, health.channels)
    assertEquals(1, health.apiVersion)

    val resume = decodeJson(
      WireContracts.ChatResume,
      """{"type":"resume","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","agentId":"a","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","sinceSeq":1e0}""",
    ) as MobileWsClientFrame.Resume
    assertEquals(1L, resume.value.sinceSeq)

    val canonicalEvent = parseJson(
      """{"type":"event","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","seq":1.0,"event":{"type":"response","content":"ok","usage":{"inputTokens":1e0,"outputTokens":2.0}}}""",
    )
    ContractAssertions.assertValid(WireDocument.ChatWs, "ChatEvent", canonicalEvent)

    ContractAssertions.assertValid(
      WireDocument.OpenApi,
      "PairingPayload",
      parseJson(
        """{"v":3e0,"host":"192.168.1.50","secure":true,"mgmtToken":"token","chatToken":"token","mgmtPort":9.4e3,"chatPort":9400.0,"tlsCertificateSha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}""",
      ),
    )

    listOf("1.5", "9223372036854775808", "-9223372036854775809").forEach { invalid ->
      assertContractRejected(
        WireContracts.ChatResume,
        """{"type":"resume","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","agentId":"a","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","sinceSeq":$invalid}""",
      )
      assertThrows(invalid, IllegalArgumentException::class.java) {
        ContractAssertions.assertValid(
          WireDocument.ChatWs,
          "ChatEvent",
          parseJson(
            """{"type":"event","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","seq":1,"event":{"type":"response","content":"ok","usage":{"inputTokens":$invalid,"outputTokens":2}}}""",
          ),
        )
      }
    }
  }

  @Test
  fun ecmascriptWhitespaceMatchesAjvPatterns() {
    val models = FixtureLoader.value("models-list.json").jsonObject
    val firstModel = models.getValue("models").jsonArray.first().jsonObject
    val pairing = FixtureLoader.value("pairing-lan-v3.json").jsonObject

    listOf('\u00a0', '\u2003').forEach { whitespace ->
      val invalidModels = JsonObject(
        models + (
          "models" to JsonArray(
            listOf(JsonObject(firstModel + ("value" to JsonPrimitive("provider/${whitespace}model")))),
          )
        ),
      )
      assertContractRejected(WireContracts.MobileModelsResponse, invalidModels)

      assertThrows(IllegalArgumentException::class.java) {
        ContractAssertions.assertValid(
          WireDocument.OpenApi,
          "PairingPayload",
          JsonObject(pairing + ("host" to JsonPrimitive("dash${whitespace}gateway"))),
        )
      }
    }
  }

  @Test
  fun modelIdentifiersUseFrozenEcmaScriptWhitespace() {
    val models = FixtureLoader.value("models-list.json").jsonObject
    val firstModel = models.getValue("models").jsonArray.first().jsonObject
    fun response(value: String): JsonObject = JsonObject(
      models + (
        "models" to JsonArray(
          listOf(JsonObject(firstModel + ("value" to JsonPrimitive(value)))),
        )
      ),
    )

    listOf(
      "provider/\u0085model",
      "pro\u0085vider/model",
      "provider/family/model",
    ).forEach { value ->
      assertEquals(
        value,
        WireContractValidator.decodeRuntime(
          WireContracts.MobileModelsResponse,
          response(value),
        ).models.single().value,
      )
    }

    val ecmaScriptWhitespace = listOf(
      '\u0009',
      '\u000a',
      '\u000b',
      '\u000c',
      '\u000d',
      '\u0020',
      '\u00a0',
      '\u1680',
      '\u2003',
      '\u2028',
      '\u2029',
      '\u202f',
      '\u205f',
      '\u3000',
      '\ufeff',
    )
    ecmaScriptWhitespace.forEach { whitespace ->
      listOf("pro${whitespace}vider/model", "provider/${whitespace}model").forEach { value ->
        assertContractRejected(WireContracts.MobileModelsResponse, response(value))
      }
    }
    listOf("provider", "/model", "provider/").forEach { value ->
      assertContractRejected(WireContracts.MobileModelsResponse, response(value))
    }
  }

  @Test
  fun rfc3339OffsetsUseTheFullWireRange() {
    fun healthAt(timestamp: String): String =
      """{"status":"healthy","startedAt":"$timestamp","pid":1,"agents":0,"channels":0,"apiVersion":1,"capabilities":[]}"""

    listOf(
      "2026-01-01T00:00:00+19:00",
      "2026-01-01T23:59:59.123+23:59",
      "2024-02-29T00:00:00-23:59",
    ).forEach { timestamp ->
      assertEquals(
        timestamp,
        decodeJson(WireContracts.MobileHealth, healthAt(timestamp)).startedAt,
      )
    }

    ContractAssertions.assertValid(
      WireDocument.ChatWs,
      "ChatEvent",
      parseJson(
        """{"type":"event","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","seq":1,"event":{"type":"error","error":"bad","timestamp":"2026-01-01T00:00:00+19:00"}}""",
      ),
    )

    listOf(
      "2026-01-01T00:00:00+24:00",
      "2026-01-01T00:00:00-24:00",
      "2026-01-01T00:00:00+23:60",
      "2026-01-01T00:00:00+19",
      "2026-02-29T00:00:00+19:00",
      "2026-01-01T24:00:00+19:00",
    ).forEach { timestamp ->
      assertContractRejected(WireContracts.MobileHealth, healthAt(timestamp))
    }
  }

  @Test
  fun canonicalAgentEventScanningStopsAtSchemaOpenSubtrees() {
    val nestedMalformedEvent = parseJson(
      """{"type":"event","event":{"type":"text_delta"}}""",
    )
    val pairing = FixtureLoader.value("pairing-lan-v3.json").jsonObject
    ContractAssertions.assertValid(
      WireDocument.OpenApi,
      "PairingPayload",
      JsonObject(pairing + ("futureMetadata" to nestedMalformedEvent)),
    )
    ContractAssertions.assertValid(
      WireDocument.OpenApi,
      "MobileApiError",
      parseJson(
        """{"code":"validation_failed","error":"bad","retryable":false,"details":{"nested":$nestedMalformedEvent}}""",
      ),
    )
    ContractAssertions.assertValid(
      WireDocument.ChatWs,
      "ChatEvent",
      parseJson(
        """{"type":"event","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","seq":1,"event":{"type":"future_event","payload":$nestedMalformedEvent}}""",
      ),
    )

    val futureContent = parseJson(
      syntheticContentPage(
        """{"type":"future_card","payload":$nestedMalformedEvent}""",
      ),
    )
    val futureContentFailure = assertThrows(IllegalArgumentException::class.java) {
      ContractAssertions.assertValid(
        WireDocument.OpenApi,
        "ConversationMessagePage",
        futureContent,
      )
    }
    assertEquals("unknown canonical conversation content", futureContentFailure.message)

    val malformedKnownEvent = """{"type":"text_delta","text":"ok","extra":true}"""
    val canonicalChat =
      """{"type":"event","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","seq":1,"event":$malformedKnownEvent}"""
    val canonicalReplay =
      """{"entries":[{"seq":1,"msgId":"m","agentId":"a","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","timestamp":"2026-01-01T00:00:00Z","payload":{"type":"event","event":$malformedKnownEvent}}]}"""
    val canonicalConversation = syntheticContentPage(
      """{"type":"assistant","events":[$malformedKnownEvent]}""",
    )
    listOf(
      Triple(WireDocument.ChatWs, "ChatEvent", parseJson(canonicalChat)),
      Triple(WireDocument.OpenApi, "ReplayPage", parseJson(canonicalReplay)),
      Triple(
        WireDocument.OpenApi,
        "ConversationMessagePage",
        parseJson(canonicalConversation),
      ),
    ).forEach { (document, schema, raw) ->
      assertThrows(schema, IllegalArgumentException::class.java) {
        ContractAssertions.assertValid(document, schema, raw)
      }
    }
  }

  @Test
  fun schemaStringLengthsUseUnicodeCodePoints() {
    val supplementary = "\ud83d\ude80"
    val thirtyOneCodePointTicket = "a".repeat(30) + supplementary
    assertContractRejected(
      WireContracts.WsTicketResponse,
      """{"ticket":"$thirtyOneCodePointTicket","expiresAt":"2026-01-01T00:00:00Z"}""",
    )
    val thirtyTwoCodePointTicket = "a".repeat(31) + supplementary
    assertEquals(
      thirtyTwoCodePointTicket,
      decodeJson(
        WireContracts.WsTicketResponse,
        """{"ticket":"$thirtyTwoCodePointTicket","expiresAt":"2026-01-01T00:00:00Z"}""",
      ).ticket,
    )

    val twoCodePointRegion = supplementary.repeat(2)
    val twoHundredCodePointText = "a".repeat(199) + supplementary
    val validLocation =
      """{"type":"message","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","agentId":"a","channelId":"android","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","text":"x","resumable":true,"location":{"timezone":"$twoHundredCodePointText","utcOffsetMinutes":0,"locale":"$twoHundredCodePointText","region":"$twoCodePointRegion","precise":{"latitude":0,"longitude":0,"accuracyMeters":0,"capturedAt":"2026-01-01T00:00:00Z","place":"$twoHundredCodePointText"}}}"""
    WireContractValidator.decodeRuntime(WireContracts.ChatSend, parseJson(validLocation))

    val oneCodePointRegion = validLocation.replace(
      "\"region\":\"$twoCodePointRegion\"",
      "\"region\":\"$supplementary\"",
    )
    assertContractRejected(WireContracts.ChatSend, oneCodePointRegion)
  }

  @Test
  fun isoDatesRequireExactBareYearMonthDayForm() {
    val memory = FixtureLoader.value("memory-list.json").jsonArray.first().jsonObject
    listOf("+10000-01-01", "2026-1-01", "2026-01-1", "2026-01-01Z").forEach { invalid ->
      assertContractRejected(
        WireContracts.MemoryInfoList,
        JsonArray(listOf(JsonObject(memory + ("createdAt" to JsonPrimitive(invalid))))),
      )
    }

    val models = FixtureLoader.value("models-list.json").jsonObject
    assertContractRejected(
      WireContracts.MobileModelsResponse,
      JsonObject(models + ("supportedModelsReviewedAt" to JsonPrimitive("+10000-01-01"))),
    )
  }

  @Test
  fun wireContractDescriptorRegistryIsExactlyTyped() {
    val expected = listOf(
      descriptor<MobileHealth>("MobileHealth", WireDocument.OpenApi, WireContracts.MobileHealth),
      descriptor<GatewayIdentity>(
        "GatewayIdentity",
        WireDocument.OpenApi,
        WireContracts.GatewayIdentity,
      ),
      descriptor<WsTicketResponse>(
        "WsTicketResponse",
        WireDocument.OpenApi,
        WireContracts.WsTicketResponse,
      ),
      descriptor<MobileAgent>("MobileAgent", WireDocument.OpenApi, WireContracts.MobileAgent),
      descriptor<List<MobileAgent>>(
        "MobileAgentList",
        WireDocument.OpenApi,
        WireContracts.MobileAgentList,
      ),
      descriptor<CreateMobileAgentRequest>(
        "CreateMobileAgentRequest",
        WireDocument.OpenApi,
        WireContracts.CreateMobileAgentRequest,
      ),
      descriptor<UpdateMobileAgentRequest>(
        "UpdateMobileAgentRequest",
        WireDocument.OpenApi,
        WireContracts.UpdateMobileAgentRequest,
      ),
      descriptor<MobileActionResponse>(
        "MobileActionResponse",
        WireDocument.OpenApi,
        WireContracts.MobileActionResponse,
      ),
      descriptor<List<MobileSkill>>(
        "MobileSkillList",
        WireDocument.OpenApi,
        WireContracts.MobileSkillList,
      ),
      descriptor<List<MobileMemoryInfo>>(
        "MemoryInfoList",
        WireDocument.OpenApi,
        WireContracts.MemoryInfoList,
      ),
      descriptor<MobileMemoryRecord>(
        "MemoryRecord",
        WireDocument.OpenApi,
        WireContracts.MemoryRecord,
      ),
      descriptor<MobileMemoryDeleteResponse>(
        "MemoryDeleteResponse",
        WireDocument.OpenApi,
        WireContracts.MemoryDeleteResponse,
      ),
      descriptor<MemoryNotFoundError>(
        "MemoryNotFoundError",
        WireDocument.OpenApi,
        WireContracts.MemoryNotFoundError,
      ),
      descriptor<MobileModelsResponse>(
        "MobileModelsResponse",
        WireDocument.OpenApi,
        WireContracts.MobileModelsResponse,
      ),
      descriptor<MobileApiError>(
        "MobileApiError",
        WireDocument.OpenApi,
        WireContracts.MobileApiError,
      ),
      descriptor<MobileApiError>(
        "ConversationBusyError",
        WireDocument.OpenApi,
        WireContracts.ConversationBusyError,
      ),
      descriptor<ConversationDefaults>(
        "ConversationDefaults",
        WireDocument.OpenApi,
        WireContracts.ConversationDefaults,
      ),
      descriptor<ConversationSummary>(
        "ConversationSummary",
        WireDocument.OpenApi,
        WireContracts.ConversationSummary,
      ),
      descriptor<ConversationPage>(
        "ConversationPage",
        WireDocument.OpenApi,
        WireContracts.ConversationPage,
      ),
      descriptor<ConversationMessagePage>(
        "ConversationMessagePage",
        WireDocument.OpenApi,
        WireContracts.ConversationMessagePage,
      ),
      descriptor<ConversationCreateRequest>(
        "ConversationCreateRequest",
        WireDocument.OpenApi,
        WireContracts.ConversationCreateRequest,
      ),
      descriptor<ConversationPatchRequest>(
        "ConversationPatchRequest",
        WireDocument.OpenApi,
        WireContracts.ConversationPatchRequest,
      ),
      descriptor<MobileApiError>(
        "RevisionConflictError",
        WireDocument.OpenApi,
        WireContracts.RevisionConflictError,
      ),
      descriptor<ConversationContent>(
        "ConversationContent",
        WireDocument.Internal,
        WireContracts.ConversationContent,
      ),
      descriptor<MobileWsClientFrame>("ChatSend", WireDocument.ChatWs, WireContracts.ChatSend),
      descriptor<MobileWsClientFrame>("ChatResume", WireDocument.ChatWs, WireContracts.ChatResume),
      descriptor<MobileWsClientFrame>("ChatAnswer", WireDocument.ChatWs, WireContracts.ChatAnswer),
      descriptor<MobileWsClientFrame>("ChatCancel", WireDocument.ChatWs, WireContracts.ChatCancel),
      descriptor<MobileWsClientFrame>(
        "MobileWsClientFrame",
        WireDocument.ChatWs,
        WireContracts.MobileWsClientFrame,
      ),
      descriptor<MobileWsServerFrame>(
        "ChatAccepted",
        WireDocument.ChatWs,
        WireContracts.ChatAccepted,
      ),
      descriptor<MobileWsServerFrame>("ChatEvent", WireDocument.ChatWs, WireContracts.ChatEvent),
      descriptor<MobileWsServerFrame>("ChatDone", WireDocument.ChatWs, WireContracts.ChatDone),
      descriptor<MobileWsServerFrame>("ChatError", WireDocument.ChatWs, WireContracts.ChatError),
      descriptor<MobileWsServerFrame>(
        "MobileWsServerFrame",
        WireDocument.ChatWs,
        WireContracts.MobileWsServerFrame,
      ),
      descriptor<ReplayPage>("ReplayPage", WireDocument.OpenApi, WireContracts.ReplayPage),
      descriptor<GatewayInvalidation>(
        "ConversationChangedEvent",
        WireDocument.OpenApi,
        WireContracts.ConversationChangedEvent,
      ),
      descriptor<GatewayInvalidation>(
        "ConversationDeletedEvent",
        WireDocument.OpenApi,
        WireContracts.ConversationDeletedEvent,
      ),
      descriptor<JsonObject>(
        "StoredGatewayEventPayload",
        WireDocument.Internal,
        WireContracts.StoredGatewayEventPayload,
      ),
      descriptor<MobileAgentConfig>(
        "MobileAgentConfig",
        WireDocument.Internal,
        WireContracts.MobileAgentConfig,
      ),
    )

    val publicDescriptors = WireContracts::class.java.methods
      .filter { method ->
        method.declaringClass == WireContracts::class.java &&
          method.parameterCount == 0 &&
          WireContract::class.java.isAssignableFrom(method.returnType)
      }
      .associate { method -> method.name.removePrefix("get") to method.invoke(WireContracts) }
    assertEquals(expected.mapTo(mutableSetOf(), DescriptorExpectation::property), publicDescriptors.keys)
    expected.forEach { item ->
      assertTrue(item.contract === publicDescriptors.getValue(item.property))
      assertEquals(item.document, item.contract.document)
      assertEquals(item.property, item.contract.schema)
    }
  }

  @Test
  fun everyOptionalNonNullFieldRejectsExplicitNull() {
    val cases = mutableListOf<NullMutationCase>()
    fun add(contract: WireContract<*>, base: JsonElement, vararg paths: String) {
      paths.forEach { path ->
        cases += NullMutationCase(contract, base, path.split('.'))
      }
    }

    val agent = parseJson(
      """{"id":"agent","name":"Agent","config":{"name":"Agent","model":"provider/model","systemPrompt":"","fallbackModels":["provider/model"],"tools":["tool"],"skills":{"paths":["path"],"urls":["https://example.test"]},"workspace":"workspace","maxTokens":1,"mcpServers":["server"],"plugins":["plugin"],"providers":["provider"],"swarm":{"enabled":true,"maxConcurrentWorkers":1,"maxWorkersPerRun":1,"maxSteersPerWorker":0,"maxRunSeconds":1,"allowedModels":["provider/model"]}},"status":"active","registeredAt":"2026-01-01T00:00:00Z"}""",
    )
    add(
      WireContracts.MobileAgent,
      agent,
      "config.fallbackModels",
      "config.tools",
      "config.skills",
      "config.workspace",
      "config.maxTokens",
      "config.mcpServers",
      "config.plugins",
      "config.providers",
      "config.swarm",
      "config.skills.paths",
      "config.skills.urls",
      "config.swarm.enabled",
      "config.swarm.maxConcurrentWorkers",
      "config.swarm.maxWorkersPerRun",
      "config.swarm.maxSteersPerWorker",
      "config.swarm.maxRunSeconds",
      "config.swarm.allowedModels",
    )
    add(
      WireContracts.MobileSkillList,
      parseJson(
        """[{"name":"skill","description":"description","trigger":"trigger","source":"managed","content":"content"}]""",
      ),
      "0.trigger",
      "0.content",
    )
    add(
      WireContracts.UpdateMobileAgentRequest,
      parseJson("""{"model":"provider/model","systemPrompt":"prompt"}"""),
      "model",
      "systemPrompt",
    )
    add(
      WireContracts.ConversationSummary,
      JsonObject(
        FixtureLoader.value("conversation-summary.json").jsonObject +
          ("deletedAt" to JsonPrimitive("2026-01-02T00:00:00Z")),
      ),
      "deletedAt",
    )
    add(
      WireContracts.ConversationCreateRequest,
      FixtureLoader.value("conversation-create.json"),
      "title",
      "owningIssueId",
      "projectId",
    )
    add(
      WireContracts.ConversationPatchRequest,
      parseJson("""{"title":"title"}"""),
      "title",
    )
    add(
      WireContracts.ConversationContent,
      parseJson("""{"type":"user","text":"text","images":[]}"""),
      "images",
    )
    add(
      WireContracts.MobileApiError,
      parseJson(
        """{"code":"validation_failed","error":"bad","retryable":false,"details":{}}""",
      ),
      "details",
    )
    add(
      WireContracts.StoredGatewayEventPayload,
      parseJson("""{"type":"done","outcome":"completed"}"""),
      "outcome",
    )
    add(
      WireContracts.StoredGatewayEventPayload,
      parseJson("""{"type":"error","error":"bad","code":"not_found","retryable":false}"""),
      "code",
      "retryable",
    )

    val message = FixtureLoader.value("chat-send-with-location.json")
    add(
      WireContracts.ChatSend,
      message,
      "location.precise.place",
      "location.region",
      "location.precise",
      "location",
      "images",
      "streamingBehavior",
    )
    val error = FixtureLoader.value("chat-error.json")
    add(WireContracts.ChatError, error, "code", "retryable", "activeTurnId")
    add(
      WireContracts.MobileWsClientFrame,
      message,
      "location",
      "images",
      "streamingBehavior",
      "resumable",
    )
    add(
      WireContracts.MobileWsServerFrame,
      FixtureLoader.value("chat-event.json"),
      "conversationId",
      "seq",
    )
    add(
      WireContracts.MobileWsServerFrame,
      FixtureLoader.value("chat-done.json"),
      "conversationId",
      "seq",
      "outcome",
    )
    add(
      WireContracts.MobileWsServerFrame,
      error,
      "conversationId",
      "seq",
      "code",
      "retryable",
      "activeTurnId",
    )

    assertEquals(54, cases.size)
    cases.forEach { case ->
      assertContractRejectedErased(
        case.contract,
        replaceAtPath(case.base, case.path, JsonNull),
        "${case.contract.schema}.${case.path.joinToString(".")}",
      )
    }
  }

  @Test
  fun gatewayAgentSkillAndErrorContracts() {
    val health = WireContractValidator.decodeRuntime(
      WireContracts.MobileHealth,
      FixtureLoader.value("health-capabilities.json"),
    )
    assertEquals("healthy", health.status)
    assertEquals(1, health.apiVersion)
    assertEquals(
      listOf(MobileCapability.ConversationSyncV1, MobileCapability.ChatResumeV1),
      health.capabilities,
    )
    listOf(
      """{"status":"unhealthy","startedAt":"2026-01-01T00:00:00Z","pid":1,"agents":0,"channels":0,"apiVersion":1,"capabilities":[]}""",
      """{"status":"healthy","startedAt":"not-a-date","pid":1,"agents":0,"channels":0,"apiVersion":1,"capabilities":[]}""",
      """{"status":"healthy","startedAt":"2026-01-01T00:00Z","pid":1,"agents":0,"channels":0,"apiVersion":1,"capabilities":[]}""",
      """{"status":"healthy","startedAt":"2026-01-01T00:00:00Z","pid":0,"agents":0,"channels":0,"apiVersion":1,"capabilities":[]}""",
      """{"status":"healthy","startedAt":"2026-01-01T00:00:00Z","pid":1,"agents":-1,"channels":0,"apiVersion":1,"capabilities":[]}""",
      """{"status":"healthy","startedAt":"2026-01-01T00:00:00Z","pid":1,"agents":0,"channels":0,"apiVersion":2,"capabilities":[]}""",
      """{"status":"healthy","startedAt":"2026-01-01T00:00:00Z","pid":1,"agents":0,"channels":0,"apiVersion":1,"capabilities":["chat-resume-v1","chat-resume-v1"]}""",
    ).forEach { assertContractRejected(WireContracts.MobileHealth, it) }

    assertEquals(
      FixtureLoader.value("identity.json").jsonObject.getValue("gatewayId").toString().trim('"'),
      WireContractValidator.decodeRuntime(
        WireContracts.GatewayIdentity,
        FixtureLoader.value("identity.json"),
      ).gatewayId,
    )
    assertContractRejected(WireContracts.GatewayIdentity, """{"gatewayId":"","publicKey":"key"}""")
    assertContractRejected(
      WireContracts.WsTicketResponse,
      """{"ticket":"short","expiresAt":"2026-01-01T00:00:00Z"}""",
    )
    assertContractRejected(
      WireContracts.WsTicketResponse,
      """{"ticket":"abcdefghijklmnopqrstuvwxyz123456","expiresAt":"nope"}""",
    )

    val agents = WireContractValidator.decodeRuntime(
      WireContracts.MobileAgentList,
      FixtureLoader.value("agents-list.json"),
    )
    assertTrue(agents.isNotEmpty())
    assertEquals(agents.first().name, agents.first().config.name)
    val agentRaw = FixtureLoader.value("agents-list.json").jsonArray.first().jsonObject
    val nullConfig = JsonObject(agentRaw.getValue("config").jsonObject + ("workspace" to JsonNull))
    assertContractRejected(
      WireContracts.MobileAgentList,
      JsonArray(listOf(JsonObject(agentRaw + ("config" to nullConfig)))),
    )
    val nullSkills = JsonObject(
      agentRaw.getValue("config").jsonObject +
        ("skills" to JsonObject(mapOf("paths" to JsonNull))),
    )
    assertContractRejected(
      WireContracts.MobileAgentList,
      JsonArray(listOf(JsonObject(agentRaw + ("config" to nullSkills)))),
    )
    val nullSwarm = JsonObject(
      agentRaw.getValue("config").jsonObject +
        ("swarm" to JsonObject(mapOf("enabled" to JsonNull))),
    )
    assertContractRejected(
      WireContracts.MobileAgentList,
      JsonArray(listOf(JsonObject(agentRaw + ("config" to nullSwarm)))),
    )
    assertContractRejected(
      WireContracts.CreateMobileAgentRequest,
      """{"name":"","model":"provider/model","systemPrompt":""}""",
    )
    assertContractRejected(WireContracts.UpdateMobileAgentRequest, "{}")
    assertContractRejected(WireContracts.UpdateMobileAgentRequest, """{"model":null}""")
    assertContractRejected(WireContracts.UpdateMobileAgentRequest, """{"model":""}""")
    assertContractRejected(WireContracts.MobileActionResponse, """{"ok":false}""")

    val skillsRaw = """[
      {"name":"managed","description":"first","source":"managed"},
      {"name":"future","description":"second","trigger":"on use","source":"catalog-v2","content":"body"}
    ]"""
    val skills = decodeJson(WireContracts.MobileSkillList, skillsRaw)
    assertEquals(MobileSkillSource.Managed, skills[0].source)
    assertEquals(MobileSkillSource.Unknown("catalog-v2"), skills[1].source)
    assertEquals(
      parseJson(skillsRaw),
      WireContractValidator.encodeRuntime(WireContracts.MobileSkillList, skills),
    )
    assertContractRejected(
      WireContracts.MobileSkillList,
      """[{"name":"x","description":"x","trigger":null,"source":"managed"}]""",
    )
    ContractAssertions.assertValid(
      WireDocument.OpenApi,
      "MobileSkillList",
      parseJson("""[{"name":"x","description":"x","source":"managed"}]"""),
    )
    assertThrows(IllegalArgumentException::class.java) {
      ContractAssertions.assertValid(
        WireDocument.OpenApi,
        "MobileSkillList",
        parseJson("""[{"name":"x","description":"x","source":"catalog-v2"}]"""),
      )
    }

    val memories = WireContractValidator.decodeRuntime(
      WireContracts.MemoryInfoList,
      FixtureLoader.value("memory-list.json"),
    )
    assertTrue(memories.all { it.size >= 0 })
    assertContractRejected(
      WireContracts.MemoryInfoList,
      """[{"name":"x","description":"","type":"other","source":"agent","createdAt":"2026-02-30","updatedAt":"2026-01-01","size":0}]""",
    )
    assertEquals(
      "body",
      decodeJson(
        WireContracts.MemoryRecord,
        """{"name":"x","description":"","type":"user","source":"import","createdAt":"2026-01-01","updatedAt":"2026-01-02","content":"body"}""",
      ).content,
    )
    assertEquals(
      "x",
      decodeJson(WireContracts.MemoryDeleteResponse, """{"name":"x"}""").name,
    )
    assertEquals(
      "not found",
      decodeJson(WireContracts.MemoryNotFoundError, """{"error":"not found"}""").error,
    )
    assertContractRejected(WireContracts.MemoryNotFoundError, """{"error":""}""")

    val models = WireContractValidator.decodeRuntime(
      WireContracts.MobileModelsResponse,
      FixtureLoader.value("models-list.json"),
    )
    assertTrue(models.models.isNotEmpty())
    assertContractRejected(
      WireContracts.MobileModelsResponse,
      """{"models":[{"value":"missing-slash","label":"x","provider":"p"}],"source":"live","errors":{},"fetchedAt":"2026-01-01T00:00:00Z","supportedModelsReviewedAt":"2026-01-01"}""",
    )
    assertContractRejected(
      WireContracts.MobileModelsResponse,
      """{"models":[],"source":"cached","errors":{},"fetchedAt":"2026-01-01T00:00:00Z","supportedModelsReviewedAt":"unreviewed"}""",
    )

    listOf(
      "errors/unauthorized.json",
      "errors/not-found.json",
      "errors/validation-failed.json",
      "errors/rate-limited.json",
      "errors/gateway-offline.json",
      "errors/capability-required.json",
    ).forEach { file ->
      WireContractValidator.decodeRuntime(WireContracts.MobileApiError, FixtureLoader.value(file))
    }
    assertContractRejected(
      WireContracts.MobileApiError,
      """{"code":"future","error":"x","retryable":false}""",
    )
    assertContractRejected(
      WireContracts.MobileApiError,
      """{"code":"not_found","error":"x","retryable":false,"details":null}""",
    )
    decodeJson(
      WireContracts.MobileApiError,
      """{"code":"rate_limited","error":"slow","retryable":true,"details":{"retryAt":null}}""",
    )
    assertEquals(
      "018f0f4a-5c42-7a8b-9c01-2234567890ab",
      WireContractValidator.decodeRuntime(
        WireContracts.ConversationBusyError,
        FixtureLoader.value("errors/conversation-busy.json"),
      ).details?.get("activeTurnId")?.toString()?.trim('"'),
    )
    assertContractRejected(
      WireContracts.ConversationBusyError,
      """{"code":"conversation_busy","error":"busy","retryable":true,"details":{"activeTurnId":""}}""",
    )

    val knownEvents = listOf(
      """{"type":"text_delta","text":"hello"}""",
      """{"type":"thinking_delta","text":"hmm"}""",
      """{"type":"tool_use_start","id":"tool","name":"read","input":{"x":1}}""",
      """{"type":"tool_use_delta","partial_json":"{}"}""",
      """{"type":"tool_result","id":"tool","name":"read","content":"ok","isError":false,"details":null}""",
      """{"type":"response","content":"done","usage":{"inputTokens":1,"outputTokens":2}}""",
      """{"type":"error","error":"boom","timestamp":"2026-01-01T00:00:00Z"}""",
      """{"type":"file_changed","files":["a.kt"]}""",
      """{"type":"agent_spawned","name":"worker"}""",
      """{"type":"worker_spawned","workerId":"w","runId":"r","role":"dev","brief":"b","model":"p/m"}""",
      """{"type":"worker_status","workerId":"w","runId":"r","role":"dev","status":"waiting_input","detail":"d","question":"q"}""",
      """{"type":"worker_done","workerId":"w","runId":"r","role":"dev","status":"done","report":"ok","usage":{"inputTokens":1,"outputTokens":2,"cacheReadTokens":3,"cacheWriteTokens":4}}""",
      """{"type":"agent_retry","attempt":1,"reason":"retry"}""",
      """{"type":"context_compacted","overflow":true}""",
      """{"type":"question","id":"q","question":"Pick?","options":["a","b"]}""",
      """{"type":"skill_loaded","name":"git"}""",
      """{"type":"skill_created","name":"git","description":"desc"}""",
      """{"type":"mcp_server_error","server":"s","error":"down"}""",
      """{"type":"memory_saved","name":"n","description":"d","memoryType":"user","action":"created"}""",
      """{"type":"memory_forgotten","name":"n"}""",
    )
    knownEvents.forEach { raw ->
      val value = parseJson(raw)
      val event = ContractJson.strict.decodeFromJsonElement<AgentEvent>(value)
      assertEquals(value, ContractJson.strict.encodeToJsonElement(AgentEvent.serializer(), event))
    }
    assertEquals(
      parseJson("""{"type":"future_event","anything":null}"""),
      ContractJson.strict.encodeToJsonElement(
        AgentEvent.serializer(),
        ContractJson.strict.decodeFromString<AgentEvent>(
          """{"type":"future_event","anything":null}""",
        ),
      ),
    )
    ContractJson.strict.decodeFromString<AgentEvent>(
      """{"type":"text_delta","text":"ok","workerId":null}""",
    )
    ContractJson.strict.decodeFromString<AgentEvent>(
      """{"type":"memory_saved","memoryType":"future_bucket"}""",
    )
    ContractJson.strict.decodeFromString<AgentEvent>(
      """{"type":"memory_saved","memoryType":"user","action":"future_action"}""",
    )
    listOf(
      """{"type":"text_delta"}""",
      """{"type":"text_delta","text":"ok","workerId":3}""",
      """{"type":"text_delta","text":"ok","timestamp":"not-a-date"}""",
      """{"type":"response","content":"ok","usage":{"inputTokens":1.5,"outputTokens":2}}""",
      """{"type":"error","error":"x","timestamp":"not-a-date"}""",
      """{"type":"worker_status","workerId":"w","runId":"r","role":"dev","status":"done"}""",
      """{"type":"worker_done","workerId":"w","runId":"r","role":"dev","status":"running","report":"x"}""",
      """{"type":"question","id":"q","question":"?","options":[1]}""",
      """{"type":"memory_saved","memoryType":1}""",
      """{"type":"memory_saved","memoryType":"user","action":"created"}""",
    ).forEach { raw ->
      assertThrows(raw, IllegalArgumentException::class.java) {
        ContractJson.strict.decodeFromString<AgentEvent>(raw)
      }
    }
    val malformed = AgentEvent("text_delta", parseJson("""{"type":"text_delta"}""").jsonObject)
    assertThrows(IllegalArgumentException::class.java) {
      ContractJson.strict.encodeToJsonElement(AgentEvent.serializer(), malformed)
    }
  }

  @Test
  fun conversationNoticeAndNullableContracts() {
    assertEquals(
      ConversationDefaults.DEFAULT_CONVERSATION_TITLE,
      WireContractValidator.decodeRuntime(
        WireContracts.ConversationDefaults,
        FixtureLoader.value("conversation-defaults.json"),
      ).defaultConversationTitle,
    )
    assertContractRejected(
      WireContracts.ConversationDefaults,
      """{"defaultConversationTitle":"Untitled"}""",
    )

    val summaryRaw = FixtureLoader.value("conversation-summary.json").jsonObject
    val summary = WireContractValidator.decodeRuntime(WireContracts.ConversationSummary, summaryRaw)
    assertTrue(summary.revision > 0)
    assertTrue("activeTurnId" in WireContractValidator.encodeRuntime(WireContracts.ConversationSummary, summary).jsonObject)
    val nullableSummary = JsonObject(
      summaryRaw +
        ("activeTurnId" to JsonNull) +
        ("owningIssueId" to JsonNull) +
        ("projectId" to JsonNull) +
        ("lastMessagePreview" to JsonNull),
    )
    val decodedNullable = WireContractValidator.decodeRuntime(
      WireContracts.ConversationSummary,
      nullableSummary,
    )
    val encodedNullable = WireContractValidator.encodeRuntime(
      WireContracts.ConversationSummary,
      decodedNullable,
    ).jsonObject
    assertTrue(listOf("activeTurnId", "owningIssueId", "projectId", "lastMessagePreview").all {
      encodedNullable[it] === JsonNull
    })
    assertContractRejected(
      WireContracts.ConversationSummary,
      JsonObject(summaryRaw - "activeTurnId"),
    )
    assertContractRejected(
      WireContracts.ConversationSummary,
      JsonObject(summaryRaw + ("activeTurnId" to JsonPrimitive("not-a-uuid"))),
    )
    assertContractRejected(
      WireContracts.ConversationSummary,
      JsonObject(summaryRaw + ("revision" to JsonPrimitive(0))),
    )
    assertContractRejected(
      WireContracts.ConversationSummary,
      JsonObject(summaryRaw + ("lastSeq" to JsonPrimitive(-1))),
    )
    assertContractRejected(
      WireContracts.ConversationSummary,
      JsonObject(summaryRaw + ("createdAt" to JsonPrimitive("not-a-date"))),
    )
    assertContractRejected(
      WireContracts.ConversationSummary,
      JsonObject(summaryRaw + ("deletedAt" to JsonNull)),
    )

    val nullCursorPage = JsonObject(
      FixtureLoader.value("conversations-page.json").jsonObject + ("nextCursor" to JsonNull),
    )
    val page = WireContractValidator.decodeRuntime(
      WireContracts.ConversationPage,
      nullCursorPage,
    )
    assertTrue(
      WireContractValidator.encodeRuntime(WireContracts.ConversationPage, page)
        .jsonObject.getValue("nextCursor") === JsonNull,
    )
    assertContractRejected(
      WireContracts.ConversationPage,
      JsonObject(FixtureLoader.value("conversations-page.json").jsonObject - "nextCursor"),
    )

    val messagePage = WireContractValidator.decodeRuntime(
      WireContracts.ConversationMessagePage,
      FixtureLoader.value("conversation-messages-page.json"),
    )
    assertTrue(messagePage.items.isNotEmpty())
    assertTrue(
      WireContractValidator.encodeRuntime(WireContracts.ConversationMessagePage, messagePage)
        .jsonObject.containsKey("nextCursor"),
    )
    assertContractRejected(
      WireContracts.ConversationMessagePage,
      JsonObject(
        FixtureLoader.value("conversation-messages-page.json").jsonObject +
          ("throughSeq" to JsonPrimitive(-1)),
      ),
    )
    val userWithNullImages = replaceFirstMessageContent(
      FixtureLoader.value("conversation-messages-page.json").jsonObject,
      JsonObject(mapOf("type" to JsonPrimitive("user"), "text" to JsonPrimitive("x"), "images" to JsonNull)),
    )
    assertContractRejected(WireContracts.ConversationMessagePage, userWithNullImages)
    val assistantWithNullEvents = replaceFirstMessageContent(
      FixtureLoader.value("conversation-messages-page.json").jsonObject,
      JsonObject(mapOf("type" to JsonPrimitive("assistant"), "events" to JsonNull)),
    )
    assertContractRejected(WireContracts.ConversationMessagePage, assistantWithNullEvents)

    val create = WireContractValidator.decodeRuntime(
      WireContracts.ConversationCreateRequest,
      FixtureLoader.value("conversation-create.json"),
    )
    assertTrue(create.requestId.isNotEmpty())
    assertContractRejected(
      WireContracts.ConversationCreateRequest,
      """{"agentId":"agent","requestId":"request","title":null}""",
    )
    assertContractRejected(
      WireContracts.ConversationCreateRequest,
      """{"agentId":"agent","requestId":"request","projectId":""}""",
    )

    assertEquals(
      JsonObject(mapOf("title" to JsonPrimitive("Renamed"))),
      WireContractValidator.encodeRuntime(
        WireContracts.ConversationPatchRequest,
        ConversationPatchRequest(title = "Renamed"),
      ),
    )
    assertEquals(
      JsonObject(mapOf("owningIssueId" to JsonNull)),
      WireContractValidator.encodeRuntime(
        WireContracts.ConversationPatchRequest,
        ConversationPatchRequest(owningIssueId = NullablePatchField.Null),
      ),
    )
    assertEquals(
      JsonObject(mapOf("projectId" to JsonPrimitive("project-a"))),
      WireContractValidator.encodeRuntime(
        WireContracts.ConversationPatchRequest,
        ConversationPatchRequest(projectId = NullablePatchField.Value("project-a")),
      ),
    )
    assertContractRejected(WireContracts.ConversationPatchRequest, "{}")
    assertContractRejected(WireContracts.ConversationPatchRequest, """{"title":null}""")

    val revisionError = WireContractValidator.decodeRuntime(
      WireContracts.RevisionConflictError,
      FixtureLoader.value("errors/revision-conflict.json"),
    )
    val current = ContractJson.strict.decodeFromJsonElement<ConversationSummary>(
      revisionError.details!!.getValue("current"),
    )
    assertEquals(current, GatewayFailure.RevisionConflict(current).current)
    assertContractRejected(
      WireContracts.RevisionConflictError,
      """{"code":"revision_conflict","error":"conflict","retryable":false,"details":{"current":null}}""",
    )
  }

  @Test
  fun knownNoticeAndSkillShapesDecodeBeforeDriftMerge() {
    val page = decodeJson(
      WireContracts.ConversationMessagePage,
      syntheticNoticePage("skill_learned", "Learned Kotlin", "memory_saved", "Saved preference"),
    )
    val notices = page.items.map { (it.content as ConversationContent.Notice) }
    assertEquals(listOf("Learned Kotlin", "Saved preference"), notices.map { it.text })
    assertEquals(
      listOf(ConversationNoticeKind.SkillLearned, ConversationNoticeKind.MemorySaved),
      notices.map { it.kind },
    )

    val skills = decodeJson(
      WireContracts.MobileSkillList,
      """[
        {"name":"one","description":"first","source":"managed","trigger":"use one","content":"one body"},
        {"name":"two","description":"second","source":"plugin","trigger":"use two","content":"two body"}
      ]""",
    )
    assertEquals(listOf("one", "two"), skills.map { it.name })
    assertEquals(listOf("use one", "use two"), skills.map { it.trigger })
    assertEquals(listOf("one body", "two body"), skills.map { it.content })
    assertEquals(listOf(MobileSkillSource.Managed, MobileSkillSource.Plugin), skills.map { it.source })
  }

  @Test
  fun productionExtensionPointsPreserveUnknownsWhileCanonicalAssertionsRejectThem() {
    val futureContentRaw = parseJson(
      syntheticContentPage("""{"type":"future_card","payload":{"n":1},"nullable":null}"""),
    )
    val futureContent = WireContractValidator.decodeRuntime(
      WireContracts.ConversationMessagePage,
      futureContentRaw,
    )
    val unknown = futureContent.items.single().content as ConversationContent.Unknown
    assertEquals("future_card", unknown.type)
    assertEquals(
      futureContentRaw,
      WireContractValidator.encodeRuntime(WireContracts.ConversationMessagePage, futureContent),
    )

    val futureNoticeRaw = parseJson(syntheticContentPage(
      """{"type":"notice","kind":"future_notice","text":"Future"}""",
    ))
    val futureNotice = WireContractValidator.decodeRuntime(
      WireContracts.ConversationMessagePage,
      futureNoticeRaw,
    )
    val notice = futureNotice.items.single().content as ConversationContent.Notice
    assertEquals(ConversationNoticeKind.Unknown("future_notice"), notice.kind)
    assertEquals(
      futureNoticeRaw,
      WireContractValidator.encodeRuntime(WireContracts.ConversationMessagePage, futureNotice),
    )

    val futureSkillRaw = parseJson(
      """[{"name":"future","description":"","source":"future_source"}]""",
    )
    val futureSkills = WireContractValidator.decodeRuntime(WireContracts.MobileSkillList, futureSkillRaw)
    assertEquals(MobileSkillSource.Unknown("future_source"), futureSkills.single().source)
    assertEquals(
      futureSkillRaw,
      WireContractValidator.encodeRuntime(WireContracts.MobileSkillList, futureSkills),
    )

    listOf(futureContentRaw, futureNoticeRaw).forEach { raw ->
      assertThrows(IllegalArgumentException::class.java) {
        ContractAssertions.assertValid(WireDocument.OpenApi, "ConversationMessagePage", raw)
      }
    }
    assertThrows(IllegalArgumentException::class.java) {
      ContractAssertions.assertValid(WireDocument.OpenApi, "MobileSkillList", futureSkillRaw)
    }
  }

  @Test
  fun chatFrameAndCapabilityContracts() {
    val send = MobileWsClientFrame.Message(
      ChatMessageFrame(
        id = "018f0f4a-5c42-7a8b-9c01-2234567890a1",
        agentId = "agent-a",
        conversationId = "018f0f4a-5c42-7a8b-9c01-2234567890a2",
        text = "hello",
      ),
    )
    val encodedSend = WireContractValidator.encodeRuntime(WireContracts.ChatSend, send).jsonObject
    assertEquals(JsonPrimitive(true), encodedSend["resumable"])
    assertEquals(
      setOf("type", "id", "agentId", "channelId", "conversationId", "text", "resumable"),
      encodedSend.keys,
    )
    assertFalse("location" in encodedSend)
    assertFalse("images" in encodedSend)
    assertFalse("streamingBehavior" in encodedSend)

    val locationSend = WireContractValidator.decodeRuntime(
      WireContracts.ChatSend,
      FixtureLoader.value("chat-send-with-location.json"),
    ) as MobileWsClientFrame.Message
    assertEquals("Asia/Singapore", locationSend.value.location?.timezone)
    assertEquals(480, locationSend.value.location?.utcOffsetMinutes)
    listOf(
      """{"type":"message","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","agentId":"a","channelId":"android","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","text":"x","resumable":false}""",
      """{"type":"message","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","agentId":"a","channelId":"android","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","text":"x"}""",
      """{"type":"message","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","agentId":"a","channelId":"android","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","text":"x","resumable":true,"location":null}""",
      """{"type":"message","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","agentId":"a","channelId":"android","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","text":"x","resumable":true,"images":null}""",
      """{"type":"message","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","agentId":"a","channelId":"android","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","text":"x","resumable":true,"extra":1}""",
    ).forEach { assertContractRejected(WireContracts.ChatSend, it) }

    val compatibilityMessage = decodeJson(
      WireContracts.MobileWsClientFrame,
      """{"type":"message","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","agentId":"a","channelId":"ios","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","text":"legacy"}""",
    )
    assertTrue(compatibilityMessage is MobileWsClientFrame.Message)
    assertContractRejected(
      WireContracts.MobileWsClientFrame,
      """{"type":"message","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","agentId":"a","channelId":"ios","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","text":"legacy","resumable":null}""",
    )

    val resumeZero = decodeJson(
      WireContracts.ChatResume,
      """{"type":"resume","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","agentId":"a","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","sinceSeq":0}""",
    ) as MobileWsClientFrame.Resume
    assertEquals(0L, resumeZero.value.sinceSeq)
    listOf("-1", "1.5", "null").forEach { seq ->
      assertContractRejected(
        WireContracts.ChatResume,
        """{"type":"resume","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","agentId":"a","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","sinceSeq":$seq}""",
      )
    }
    assertContractRejected(
      WireContracts.ChatResume,
      """{"type":"resume","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","agentId":"a","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2"}""",
    )

    val locationPrefix = """{"type":"message","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","agentId":"a","channelId":"android","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","text":"x","resumable":true,"location":%%}"""
    listOf(
      """{"timezone":"","utcOffsetMinutes":0,"locale":"en"}""",
      """{"timezone":"UTC","utcOffsetMinutes":841,"locale":"en"}""",
      """{"timezone":"UTC","utcOffsetMinutes":0.5,"locale":"en"}""",
      """{"timezone":"UTC","utcOffsetMinutes":0,"locale":"","region":"S"}""",
      """{"timezone":"UTC","utcOffsetMinutes":0,"locale":"en","precise":{"latitude":91,"longitude":0,"accuracyMeters":0,"capturedAt":"2026-01-01T00:00:00Z"}}""",
      """{"timezone":"UTC","utcOffsetMinutes":0,"locale":"en","precise":{"latitude":0,"longitude":181,"accuracyMeters":0,"capturedAt":"2026-01-01T00:00:00Z"}}""",
      """{"timezone":"UTC","utcOffsetMinutes":0,"locale":"en","precise":{"latitude":0,"longitude":0,"accuracyMeters":-1,"capturedAt":"2026-01-01T00:00:00Z"}}""",
      """{"timezone":"UTC","utcOffsetMinutes":0,"locale":"en","precise":{"latitude":0,"longitude":0,"accuracyMeters":0,"capturedAt":"bad"}}""",
      """{"timezone":"UTC","utcOffsetMinutes":0,"locale":"en","precise":{"latitude":0,"longitude":0,"accuracyMeters":0,"capturedAt":"2026-01-01T00:00:00Z","place":null}}""",
    ).forEach { location ->
      assertContractRejected(WireContracts.ChatSend, locationPrefix.replace("%%", location))
    }

    listOf("chat-accepted.json", "chat-event.json", "chat-done.json", "chat-error.json").forEach {
      val descriptor = when (it) {
        "chat-accepted.json" -> WireContracts.ChatAccepted
        "chat-event.json" -> WireContracts.ChatEvent
        "chat-done.json" -> WireContracts.ChatDone
        else -> WireContracts.ChatError
      }
      WireContractValidator.decodeRuntime(descriptor, FixtureLoader.value(it))
    }
    assertContractRejected(
      WireContracts.ChatError,
      """{"type":"error","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","error":"early"}""",
    )
    assertContractRejected(
      WireContracts.ChatDone,
      """{"type":"done","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","seq":1,"outcome":null}""",
    )

    val earlyError = decodeJson(
      WireContracts.MobileWsServerFrame,
      """{"type":"error","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","error":"early"}""",
    )
    assertFalse(CapableServerFrameValidator.validate(earlyError, capableBefore = false))
    assertThrows(SerializationException::class.java) {
      CapableServerFrameValidator.validate(
        MobileWsServerFrame.Event(
          id = "018f0f4a-5c42-7a8b-9c01-2234567890a1",
          event = AgentEvent("future", parseJson("""{"type":"future"}""").jsonObject),
        ),
        capableBefore = false,
      )
    }
    val accepted = WireContractValidator.decodeRuntime(
      WireContracts.ChatAccepted,
      FixtureLoader.value("chat-accepted.json"),
    )
    assertTrue(CapableServerFrameValidator.validate(accepted, capableBefore = false))
    assertThrows(SerializationException::class.java) {
      CapableServerFrameValidator.validate(
        MobileWsServerFrame.Done(
          id = "018f0f4a-5c42-7a8b-9c01-2234567890a1",
          conversationId = "018f0f4a-5c42-7a8b-9c01-2234567890a2",
          seq = 1,
        ),
        capableBefore = true,
      )
    }
    assertThrows(SerializationException::class.java) {
      CapableServerFrameValidator.validate(
        MobileWsServerFrame.Error(
          id = "018f0f4a-5c42-7a8b-9c01-2234567890a1",
          seq = 1,
          error = "bad",
        ),
        capableBefore = true,
      )
    }

    val replay = WireContractValidator.decodeRuntime(
      WireContracts.ReplayPage,
      FixtureLoader.value("replay.json"),
    )
    assertTrue(replay.entries.zipWithNext().all { (a, b) -> a.seq < b.seq })
    assertContractRejected(WireContracts.ReplayPage, FixtureLoader.value("invalid/replay-out-of-order.json"))
    assertContractRejected(
      WireContracts.ReplayPage,
      """{"entries":[{"seq":1,"msgId":"m","agentId":"a","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","timestamp":"2026-01-01T00:00:00Z","payload":{"type":"done","outcome":"future"}}]}""",
    )

    val storedFull = FixtureLoader.value("chat-accepted.json").jsonObject
    val storedReplay = parseJson(
      """{"type":"accepted","userMessageId":"018f0f4a-5c42-7a8b-9c01-2234567890b1","assistantMessageId":"018f0f4a-5c42-7a8b-9c01-2234567890b2","revision":1}""",
    ).jsonObject
    assertEquals(
      storedFull,
      WireContractValidator.decodeRuntime(WireContracts.StoredGatewayEventPayload, storedFull),
    )
    assertEquals(
      storedReplay,
      WireContractValidator.decodeRuntime(WireContracts.StoredGatewayEventPayload, storedReplay),
    )
    assertContractRejected(
      WireContracts.StoredGatewayEventPayload,
      parseJson("""{"type":"error","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","error":"early"}"""),
    )
    assertContractRejected(
      WireContracts.StoredGatewayEventPayload,
      JsonObject(storedReplay + ("extra" to JsonPrimitive(true))),
    )
    val malformedStored = parseJson(
      """{"type":"event","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","seq":1,"event":{"type":"text_delta"}}""",
    ).jsonObject
    assertContractRejected(WireContracts.StoredGatewayEventPayload, malformedStored)
    assertThrows(IllegalArgumentException::class.java) {
      WireContractValidator.encodeRuntime(WireContracts.StoredGatewayEventPayload, malformedStored)
    }
    val malformedFrame = MobileWsServerFrame.Event(
      id = "018f0f4a-5c42-7a8b-9c01-2234567890a1",
      conversationId = "018f0f4a-5c42-7a8b-9c01-2234567890a2",
      seq = 1,
      event = AgentEvent("text_delta", parseJson("""{"type":"text_delta"}""").jsonObject),
    )
    assertThrows(IllegalArgumentException::class.java) {
      WireContractValidator.encodeRuntime(WireContracts.ChatEvent, malformedFrame)
    }

    val changed = WireContractValidator.decodeRuntime(
      WireContracts.ConversationChangedEvent,
      FixtureLoader.values(
        FixtureLoader.manifest().cases.single { it.file == "sse-conversation-changed.txt" },
      ).single(),
    )
    assertTrue(changed is GatewayInvalidation.ConversationChanged)
    assertContractRejected(
      WireContracts.ConversationDeletedEvent,
      """{"type":"conversation:deleted","conversationId":"not-a-uuid","revision":0}""",
    )
  }

  @Test
  fun remainingManifestAndPairingContracts() {
    val manifest = FixtureLoader.manifest()
    manifest.cases.forEach { case ->
      FixtureLoader.values(case).forEach { value ->
        if (case.valid) {
          ContractAssertions.assertValid(case.document, case.schema, value)
        } else {
          assertThrows(case.file, IllegalArgumentException::class.java) {
            ContractAssertions.assertValid(case.document, case.schema, value)
          }
        }
      }
    }

    val pairing = FixtureLoader.value("pairing-lan-v3.json").jsonObject
    ContractAssertions.assertValid(
      WireDocument.OpenApi,
      "PairingPayload",
      JsonObject(pairing + ("futureMetadata" to JsonObject(mapOf("nullable" to JsonNull)))),
    )
    ContractAssertions.assertValid(
      WireDocument.OpenApi,
      "PairingPayload",
      JsonObject(pairing + ("futureMetadata" to JsonNull)),
    )
    listOf("host", "secure", "mgmtToken", "chatToken", "mgmtPort").forEach { field ->
      assertThrows(field, IllegalArgumentException::class.java) {
        ContractAssertions.assertValid(
          WireDocument.OpenApi,
          "PairingPayload",
          JsonObject(pairing + (field to JsonNull)),
        )
      }
    }

    val canonicalPrefix = """{"type":"event","id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","seq":1,"event":%%}"""
    val futureEvent = canonicalPrefix.replace("%%", """{"type":"future_event","raw":null}""")
    ContractAssertions.assertValid(WireDocument.ChatWs, "ChatEvent", parseJson(futureEvent))
    listOf(
      """{"type":"text_delta","text":"ok","extra":true}""",
      """{"type":"question","id":"q","question":"?","options":["a"],"extra":true}""",
      """{"type":"response","content":"ok","usage":{"inputTokens":1,"outputTokens":2,"extra":3}}""",
    ).forEach { event ->
      assertThrows(event, IllegalArgumentException::class.java) {
        ContractAssertions.assertValid(
          WireDocument.ChatWs,
          "ChatEvent",
          parseJson(canonicalPrefix.replace("%%", event)),
        )
      }
    }
    assertThrows(IllegalArgumentException::class.java) {
      ContractAssertions.assertValid(WireDocument.OpenApi, "FutureSchema", JsonObject(emptyMap()))
    }
  }
}

private data class DescriptorExpectation(
  val property: String,
  val document: WireDocument,
  val contract: WireContract<*>,
)

private fun <T> descriptor(
  property: String,
  document: WireDocument,
  contract: WireContract<T>,
): DescriptorExpectation = DescriptorExpectation(property, document, contract)

private data class NullMutationCase(
  val contract: WireContract<*>,
  val base: JsonElement,
  val path: List<String>,
)

private fun replaceAtPath(
  value: JsonElement,
  path: List<String>,
  replacement: JsonElement,
): JsonElement {
  if (path.isEmpty()) return replacement
  val segment = path.first()
  val remaining = path.drop(1)
  return when (value) {
    is JsonObject -> JsonObject(
      value + (segment to replaceAtPath(value.getValue(segment), remaining, replacement)),
    )
    is JsonArray -> {
      val index = segment.toInt()
      JsonArray(value.mapIndexed { itemIndex, item ->
        if (itemIndex == index) replaceAtPath(item, remaining, replacement) else item
      })
    }
    else -> throw IllegalArgumentException("cannot descend through $segment")
  }
}

@Suppress("UNCHECKED_CAST")
private fun assertContractRejectedErased(
  contract: WireContract<*>,
  value: JsonElement,
  message: String,
) {
  assertThrows(message, IllegalArgumentException::class.java) {
    WireContractValidator.decodeRuntime(contract as WireContract<Any?>, value)
  }
}

private fun parseJson(raw: String) = ContractJson.strict.parseToJsonElement(raw)

private fun <T> decodeJson(contract: WireContract<T>, raw: String): T =
  WireContractValidator.decodeRuntime(contract, parseJson(raw))

private fun <T> assertContractRejected(contract: WireContract<T>, raw: String) {
  assertContractRejected(contract, parseJson(raw))
}

private fun <T> assertContractRejected(contract: WireContract<T>, value: kotlinx.serialization.json.JsonElement) {
  assertThrows(IllegalArgumentException::class.java) {
    WireContractValidator.decodeRuntime(contract, value)
  }
}

private fun replaceFirstMessageContent(page: JsonObject, content: JsonObject): JsonObject {
  val items = page.getValue("items").jsonArray
  val first = JsonObject(items.first().jsonObject + ("content" to content))
  return JsonObject(page + ("items" to JsonArray(listOf(first) + items.drop(1))))
}

private fun syntheticNoticePage(
  firstKind: String,
  firstText: String,
  secondKind: String,
  secondText: String,
): String = """{
  "items":[
    {"id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","turnId":"018f0f4a-5c42-7a8b-9c01-2234567890a3","ordinal":1,"role":"assistant","status":"completed","content":{"type":"notice","kind":"$firstKind","text":"$firstText"},"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:01Z"},
    {"id":"018f0f4a-5c42-7a8b-9c01-2234567890a4","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","turnId":"018f0f4a-5c42-7a8b-9c01-2234567890a5","ordinal":2,"role":"assistant","status":"completed","content":{"type":"notice","kind":"$secondKind","text":"$secondText"},"createdAt":"2026-01-01T00:00:02Z","updatedAt":"2026-01-01T00:00:03Z"}
  ],
  "nextCursor":null,
  "throughSeq":2
}"""

private fun syntheticContentPage(content: String): String = """{
  "items":[
    {"id":"018f0f4a-5c42-7a8b-9c01-2234567890a1","conversationId":"018f0f4a-5c42-7a8b-9c01-2234567890a2","turnId":"018f0f4a-5c42-7a8b-9c01-2234567890a3","ordinal":1,"role":"assistant","status":"completed","content":$content,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:01Z"}
  ],
  "nextCursor":null,
  "throughSeq":1
}"""
