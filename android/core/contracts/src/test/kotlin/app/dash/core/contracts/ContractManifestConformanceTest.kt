package app.dash.core.contracts

import java.lang.reflect.Modifier
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonArray
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
