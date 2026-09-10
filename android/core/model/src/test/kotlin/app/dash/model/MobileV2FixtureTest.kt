package app.dash.model

import java.util.Base64
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileV2FixtureTest {
    private val json = MobileV2Json.instance

    @Test
    fun bootstrapFixturePreservesQueueAndV2Cursor() {
        val value = decodeFixture<MobileV2ConversationBootstrap>(
            "conversation-bootstrap.json",
        )
        assertEquals(12L, value.v2ThroughSeq)
        val followUps = value.pendingInputs
            .filter { it.kind == MobileV2PendingInputKind.FOLLOW_UP }
        assertEquals(2, followUps.size)
        assertEquals(followUps.sortedBy { it.enqueueOrder }, followUps)
        assertEquals(
            MobileV2PendingInputKind.STEER,
            value.pendingInputs.single { it.kind == MobileV2PendingInputKind.STEER }.kind,
        )
    }

    @Test
    fun pageFixturesPreserveV2ConversationAndDeliveryMetadata() {
        val conversations = decodeFixture<MobileV2ConversationPage>("conversation-page.json")
        val messages = decodeFixture<MobileV2ConversationMessagePage>(
            "conversation-message-page.json",
        )
        assertTrue(conversations.items.any { it.queueRevision > 0 })
        assertTrue(messages.items.any { it.deliveryKind == MobileV2DeliveryKind.STEER })
        assertTrue(messages.items.any { it.segmentIndex > 0 })
        assertTrue(messages.throughSeq > 0)
    }

    @Test
    fun unknownCapabilityDoesNotBreakHealth() {
        val value = json.decodeFromString<MobileV2HealthResponse>(
            """{"status":"healthy","startedAt":"2026-09-06T00:00:00.000Z","pid":1,"agents":1,"channels":1,"apiVersion":2,"capabilities":["chat-input-queue-v1","future"]}""",
        )
        assertTrue("future" in value.capabilities)
    }

    @Test
    fun followUpMayOmitTargetButSteerCommandMayNot() {
        val followUp = json.decodeFromString<MobileV2PendingInput>(
            """{"inputId":"00000000-0000-4000-8000-000000000031","kind":"follow_up","text":"later","state":"queued","revision":0,"enqueueOrder":1,"createdAt":"2026-09-06T00:00:00.000Z","updatedAt":"2026-09-06T00:00:00.000Z"}""",
        )
        assertNull(followUp.targetTurnId)

        assertThrows(IllegalArgumentException::class.java) {
            json.decodeFromString<MobileV2WsClientFrame>(
                """{"type":"enqueue_input","id":"00000000-0000-4000-8000-000000000001","inputId":"00000000-0000-4000-8000-000000000031","agentId":"agent-1","channelId":"mobile","conversationId":"00000000-0000-4000-8000-000000000011","text":"now","behavior":"steer"}""",
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            json.decodeFromString<MobileV2WsClientFrame>(
                """{"type":"enqueue_input","id":"00000000-0000-4000-8000-000000000002","inputId":"00000000-0000-4000-8000-000000000032","agentId":"agent-1","channelId":"mobile","conversationId":"00000000-0000-4000-8000-000000000011","text":"later","behavior":"followUp","expectedActiveTurnId":"turn-01"}""",
            )
        }
    }

    @Test
    fun fixtureManifestRoundTripsEverySupportedDocumentAndRejectsInvalidDocuments() {
        val manifest = decodeFixture<FixtureManifest>("manifest.json")
        assertEquals(2, manifest.version)

        manifest.cases.forEach { case ->
            val documents = if (case.format == "jsonl") {
                fixtureText(case.file).lineSequence().filter { it.isNotBlank() }.toList()
            } else {
                listOf(fixtureText(case.file))
            }
            documents.forEach { source ->
                if (case.valid) {
                    assertEquals(
                        case.file,
                        json.parseToJsonElement(source),
                        decodeAndEncode(case, source),
                    )
                } else {
                    assertThrows(case.file, Exception::class.java) {
                        decodeAndEncode(case, source)
                    }
                }
            }
        }
    }

    @Test
    fun legacyRunReferencesRemainOpaqueAndUseUtf8ByteBoundaries() {
        val bootstrap = decodeFixture<MobileV2ConversationBootstrap>(
            "conversation-bootstrap-legacy-run.json",
        )
        assertEquals("turn-01", bootstrap.conversation.activeTurnId)
        assertEquals("turn-01", bootstrap.messages.first().turnId)
        assertEquals("turn-01", bootstrap.messages.first().runId)

        val exactMultibyte = "🚀".repeat(64)
        MobileV2ContractValidation.requireLegacyRunId(exactMultibyte, "runId")
        MobileV2ContractValidation.requireLegacyRunId("\u00a0", "runId")
        assertThrows(IllegalArgumentException::class.java) {
            MobileV2ContractValidation.requireLegacyRunId(exactMultibyte + "a", "runId")
        }
        assertThrows(IllegalArgumentException::class.java) {
            MobileV2ContractValidation.requireLegacyRunId(" \t\r\n", "runId")
        }
    }

    @Test
    fun nestedAgentEventsRequireTypeAndPreserveUnknownObjects() {
        val rawEvent = """{"type":"future_event","future":{"value":1}}"""
        val messageSource = conversationMessage(
            content = """{"type":"assistant","events":[$rawEvent]}""",
        )
        assertEquals(
            json.parseToJsonElement(messageSource),
            roundTrip(MobileV2ConversationMessage.serializer(), messageSource),
        )
        val message = json.decodeFromString<MobileV2ConversationMessage>(messageSource)
        val event = (message.content as ConversationContent.Assistant).events.single()
        assertTrue(event is MobileV2UnknownAgentEvent)
        assertEquals(
            json.parseToJsonElement(rawEvent),
            (event as MobileV2UnknownAgentEvent).raw,
        )

        listOf("{}", """{"type":""}""", """{"type":1}""").forEach { invalidEvent ->
            assertThrows(Exception::class.java) {
                json.decodeFromString<MobileV2ConversationMessage>(
                    conversationMessage(
                        content = """{"type":"assistant","events":[$invalidEvent]}""",
                    ),
                )
            }
        }
    }

    @Test
    fun recognizedAgentEventsExposeTypedFieldsAndPreserveTheirRawExtensions() {
        val rawEvent =
            """{"type":"text_delta","text":"typed text","future":{"nested":[1,{"ok":true}]}}"""
        val source = conversationMessage(
            content = """{"type":"assistant","events":[$rawEvent]}""",
        )

        val message = json.decodeFromString<MobileV2ConversationMessage>(source)
        val event = (message.content as ConversationContent.Assistant).events.single()

        assertTrue(event is MobileV2TypedAgentEvent)
        event as MobileV2TypedAgentEvent
        assertEquals("typed text", (event.value as AgentEvent.TextDelta).text)
        assertEquals(json.parseToJsonElement(rawEvent), event.raw)
        assertEquals(
            json.parseToJsonElement(source),
            json.parseToJsonElement(
                json.encodeToString(MobileV2ConversationMessage.serializer(), message),
            ),
        )
    }

    @Test
    fun rfc3339ValidationCoversCalendarOffsetsLeapSecondsAndFullString() {
        listOf(
            "2026-09-06T01:02:03Z",
            "2026-09-06t01:02:03.123z",
            "2000-02-29T23:59:60Z",
            "2000-03-01T00:59:60+01:00",
        ).forEach { value ->
            MobileV2ContractValidation.requireRfc3339(value, "timestamp")
        }
        listOf(
            "1900-02-29T01:02:03Z",
            "2026-02-30T01:02:03Z",
            "2026-09-06 01:02:03Z",
            "2026-09-06T01:02:60Z",
            "2026-09-06T01:02:03+24:00",
            "2026-09-06T01:02:03Z\n",
        ).forEach { value ->
            assertThrows(value, IllegalArgumentException::class.java) {
                MobileV2ContractValidation.requireRfc3339(value, "timestamp")
            }
        }
    }

    @Test
    fun locationStringBoundsCountUnicodeCodePoints() {
        val exactBoundary = "e\u0301".repeat(100)
        val overBoundary = exactBoundary + "a"
        val twoCodePointRegion = "e\u0301"
        val valid = chatMessage(
            location = clientLocation(
                timezone = json.encodeToString(exactBoundary),
                region = json.encodeToString(twoCodePointRegion),
            ),
        )
        json.decodeFromString<MobileV2WsClientFrame>(valid)

        assertThrows(IllegalArgumentException::class.java) {
            json.decodeFromString<MobileV2WsClientFrame>(
                chatMessage(
                    location = clientLocation(timezone = json.encodeToString(overBoundary)),
                ),
            )
        }
    }

    @Test
    fun v2ImagesRejectUnknownKeysNullsInvalidMediaAndDecodedOversizeData() {
        val invalidImages = listOf(
            "null",
            """[{"mediaType":"image/png","data":"aGVsbG8=","future":true}]""",
            """[{"mediaType":"image/svg+xml","data":"aGVsbG8="}]""",
            """[{"mediaType":"image/png","data":"%%%"}]""",
        )
        invalidImages.forEach { images ->
            assertThrows(images, Exception::class.java) {
                json.decodeFromString<MobileV2WsClientFrame>(chatMessage(images = images))
            }
        }

        val oversized = Base64.getEncoder().encodeToString(ByteArray(5 * 1_024 * 1_024 + 1))
        assertThrows(IllegalArgumentException::class.java) {
            MobileV2ContractValidation.requireImages(
                listOf(WsMessageImage("image/png", oversized)),
                "images",
            )
        }


        var decodeAttempts = 0
        val overEncodedBoundary = "A".repeat(
            MobileV2ContractValidation.MAX_ENCODED_IMAGE_CHARS + 1,
        )
        assertThrows(IllegalArgumentException::class.java) {
            MobileV2ContractValidation.validateImage(
                WsMessageImage("image/png", overEncodedBoundary),
                "images[0]",
            ) {
                decodeAttempts++
                ByteArray(0)
            }
        }
        assertEquals(0, decodeAttempts)

        val exactBoundaryBytes = ByteArray(5 * 1_024 * 1_024)
        val exactBoundaryImage = WsMessageImage(
            "image/png",
            Base64.getEncoder().encodeToString(exactBoundaryBytes),
        )
        assertEquals(
            exactBoundaryBytes.size,
            MobileV2ContractValidation.validateImage(exactBoundaryImage, "images[0]").size,
        )
    }

    @Test
    fun optionalSchemaFieldsRejectExplicitNullInsteadOfTreatingItAsAbsent() {
        val documents = listOf(
            chatMessage(location = "null"),
            chatMessage(images = "null"),
            conversationMessage(extra = ""","deliveryStatus":null"""),
            pendingInput(extra = ""","images":null"""),
            """{"type":"command_rejected","id":"turn-01","code":"validation_failed","error":"bad","retryable":false,"details":null}""",
        )
        documents.forEachIndexed { index, source ->
            assertThrows("document $index", Exception::class.java) {
                if (index in 0..1) {
                    json.decodeFromString<MobileV2WsClientFrame>(source)
                } else if (index == 2) {
                    json.decodeFromString<MobileV2ConversationMessage>(source)
                } else if (index == 3) {
                    json.decodeFromString<MobileV2PendingInput>(source)
                } else {
                    json.decodeFromString<MobileV2WsServerFrame>(source)
                }
            }
        }
    }

    @Test
    fun strictObjectsRejectUnknownFieldsAndSafeIntegerOverflow() {
        assertThrows(Exception::class.java) {
            json.decodeFromString<MobileV2ConversationPage>(
                """{"items":[],"nextCursor":null,"future":true}""",
            )
        }
        assertThrows(Exception::class.java) {
            json.decodeFromString<MobileV2WsClientFrame>(
                chatMessage(location = clientLocation(extra = ""","future":true""")),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            json.decodeFromString<MobileV2WsClientFrame>(
                """{"type":"subscribe_conversation","id":"00000000-0000-4000-8000-000000000001","agentId":"agent","conversationId":"00000000-0000-4000-8000-000000000002","sinceV2Seq":9007199254740992}""",
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            json.decodeFromString<MobileV2WsServerFrame>(
                """{"type":"done","id":"turn-01","conversationId":"00000000-0000-4000-8000-000000000002","runId":"turn-02","segmentTurnId":"segment-01","v2Seq":1,"outcome":"completed"}""",
            )
        }
    }

    @Test
    fun requiredLiteralFieldsHaveNoDecodingDefaults() {
        listOf(
            """{"type":"hello","capabilities":[]}""",
            """{"type":"hello","contractVersion":1,"capabilities":[]}""",
            """{"type":"message","id":"turn-01","agentId":"agent","channelId":"mobile","conversationId":"00000000-0000-4000-8000-000000000002","text":"hello"}""",
            """{"type":"message","id":"turn-01","agentId":"agent","channelId":"mobile","conversationId":"00000000-0000-4000-8000-000000000002","text":"hello","resumable":false}""",
        ).forEach { source ->
            assertThrows(source, Exception::class.java) {
                json.decodeFromString<MobileV2WsClientFrame>(source)
            }
        }
    }

    private fun decodeAndEncode(case: FixtureCase, source: String): JsonElement = when (case.schema) {
        "MobileV2HealthResponse" -> roundTrip(MobileV2HealthResponse.serializer(), source)
        "MobileV2ConversationSummary" ->
            roundTrip(MobileV2ConversationSummary.serializer(), source)
        "MobileV2ConversationBootstrap" ->
            roundTrip(MobileV2ConversationBootstrap.serializer(), source)
        "MobileV2ConversationPage" -> roundTrip(MobileV2ConversationPage.serializer(), source)
        "MobileV2ConversationMessagePage" ->
            roundTrip(MobileV2ConversationMessagePage.serializer(), source)
        "MobileV2ReplayPage" -> roundTrip(MobileV2ReplayPage.serializer(), source)
        "MobileV2WsFrame" -> {
            val type = json.parseToJsonElement(source).jsonObject
                .getValue("type").jsonPrimitive.content
            if (type in CLIENT_FRAME_TYPES) {
                roundTrip(MobileV2WsClientFrame.serializer(), source)
            } else {
                roundTrip(MobileV2WsServerFrame.serializer(), source)
            }
        }
        else -> error("Unsupported fixture schema ${case.schema}")
    }

    private fun <T> roundTrip(serializer: KSerializer<T>, source: String): JsonElement {
        val decoded = json.decodeFromString(serializer, source)
        return json.parseToJsonElement(json.encodeToString(serializer, decoded))
    }

    private inline fun <reified T> decodeFixture(name: String): T =
        json.decodeFromString(fixtureText(name))

    private fun fixtureText(name: String): String {
        val resource = requireNotNull(javaClass.classLoader.getResource(name)) {
            "Missing mobile v2 fixture: $name"
        }
        return resource.readText()
    }

    private fun chatMessage(location: String? = null, images: String? = null): String {
        val locationField = location?.let { ",\"location\":$it" }.orEmpty()
        val imagesField = images?.let { ",\"images\":$it" }.orEmpty()
        return """{"type":"message","id":"turn-01","agentId":"agent-01","channelId":"mobile","conversationId":"00000000-0000-4000-8000-000000000001","text":"Hello"$locationField$imagesField,"resumable":true}"""
    }

    private fun clientLocation(
        timezone: String = "\"Asia/Singapore\"",
        region: String = "\"SG\"",
        extra: String = "",
    ): String =
        """{"timezone":$timezone,"utcOffsetMinutes":480,"locale":"en-SG","region":$region$extra}"""

    private fun conversationMessage(
        content: String = """{"type":"user","text":"Hello"}""",
        extra: String = "",
    ): String =
        """{"id":"00000000-0000-4000-8000-000000000111","conversationId":"00000000-0000-4000-8000-000000000101","turnId":"turn-01","ordinal":1,"role":"user","status":"completed","content":$content,"createdAt":"2026-09-06T09:01:00.000Z","updatedAt":"2026-09-06T09:01:00.000Z","runId":"turn-01","segmentIndex":0,"deliveryKind":"normal"$extra}"""

    private fun pendingInput(extra: String = ""): String =
        """{"inputId":"00000000-0000-4000-8000-000000000024","kind":"follow_up","text":"Later","state":"queued","revision":0,"enqueueOrder":1,"createdAt":"2026-09-06T09:00:00.000Z","updatedAt":"2026-09-06T09:00:00.000Z"$extra}"""

    @Serializable
    private data class FixtureManifest(
        val version: Int,
        val cases: List<FixtureCase>,
    )

    @Serializable
    private data class FixtureCase(
        val file: String,
        val document: String,
        val schema: String,
        val valid: Boolean,
        val format: String? = null,
    )

    private companion object {
        val CLIENT_FRAME_TYPES = setOf(
            "hello",
            "subscribe_conversation",
            "message",
            "enqueue_input",
            "edit_follow_up",
            "remove_follow_up",
            "resume_follow_ups",
            "answer",
            "cancel",
        )
    }
}
