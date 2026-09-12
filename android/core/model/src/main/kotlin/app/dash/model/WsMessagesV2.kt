package app.dash.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put

@Serializable
data class MobileV2PreciseLocation(
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Long,
    val capturedAt: String,
    val place: String? = null,
) {
    init {
        require(latitude.isFinite() && latitude in -90.0..90.0)
        require(longitude.isFinite() && longitude in -180.0..180.0)
        MobileV2ContractValidation.requireSafeInteger(
            accuracyMeters,
            field = "location.precise.accuracyMeters",
        )
        MobileV2ContractValidation.requireRfc3339(
            capturedAt,
            "location.precise.capturedAt",
        )
        place?.let {
            MobileV2ContractValidation.requireCodePointLength(
                it,
                1,
                200,
                "location.precise.place",
            )
        }
    }
}

@Serializable
data class MobileV2ClientLocation(
    val timezone: String,
    val utcOffsetMinutes: Int,
    val locale: String,
    val region: String? = null,
    val precise: MobileV2PreciseLocation? = null,
) {
    init {
        MobileV2ContractValidation.requireCodePointLength(timezone, 1, 200, "location.timezone")
        require(utcOffsetMinutes in -840..840)
        MobileV2ContractValidation.requireCodePointLength(locale, 1, 200, "location.locale")
        region?.let {
            MobileV2ContractValidation.requireCodePointLength(it, 2, 2, "location.region")
        }
    }
}

@Serializable(with = MobileV2WsClientFrameSerializer::class)
sealed interface MobileV2WsClientFrame {
    @Serializable
    @SerialName("hello")
    data class Hello(
        val contractVersion: Int,
        val capabilities: List<String>,
    ) : MobileV2WsClientFrame {
        init {
            require(contractVersion == 2)
            MobileV2ContractValidation.requireCapabilities(capabilities, "capabilities")
        }
    }

    @Serializable
    @SerialName("subscribe_conversation")
    data class SubscribeConversation(
        val id: String,
        val agentId: String,
        val conversationId: String,
        val sinceV2Seq: Long,
    ) : MobileV2WsClientFrame {
        init {
            MobileV2ContractValidation.requireCanonicalUuid(id, "id")
            MobileV2ContractValidation.requireNonEmpty(agentId, "agentId")
            MobileV2ContractValidation.requireConversationIdentifier(
                conversationId,
                "conversationId",
            )
            MobileV2ContractValidation.requireSafeInteger(sinceV2Seq, field = "sinceV2Seq")
        }
    }

    @Serializable
    @SerialName("message")
    data class Message(
        val id: String,
        val agentId: String,
        val channelId: String,
        val conversationId: String,
        val text: String,
        val location: MobileV2ClientLocation? = null,
        val images: List<
            @Serializable(with = MobileV2StrictImageSerializer::class) WsMessageImage,
        >? = null,
        val resumable: Boolean,
    ) : MobileV2WsClientFrame {
        init {
            MobileV2ContractValidation.requireLegacyRunId(id, "id")
            MobileV2ContractValidation.requireNonEmpty(agentId, "agentId")
            MobileV2ContractValidation.requireNonEmpty(channelId, "channelId")
            MobileV2ContractValidation.requireConversationIdentifier(
                conversationId,
                "conversationId",
            )
            MobileV2ContractValidation.requireImages(images, "images")
            require(resumable)
        }
    }

    @Serializable
    @SerialName("enqueue_input")
    data class EnqueueInput(
        val id: String,
        val inputId: String,
        val agentId: String,
        val channelId: String,
        val conversationId: String,
        val text: String,
        val images: List<
            @Serializable(with = MobileV2StrictImageSerializer::class) WsMessageImage,
        >? = null,
        val behavior: MobileV2InputBehavior,
        val expectedActiveTurnId: String? = null,
    ) : MobileV2WsClientFrame {
        init {
            MobileV2ContractValidation.requireCanonicalUuid(id, "id")
            MobileV2ContractValidation.requireCanonicalUuid(inputId, "inputId")
            MobileV2ContractValidation.requireNonEmpty(agentId, "agentId")
            MobileV2ContractValidation.requireNonEmpty(channelId, "channelId")
            MobileV2ContractValidation.requireConversationIdentifier(
                conversationId,
                "conversationId",
            )
            MobileV2ContractValidation.requireImages(images, "images")
            when (behavior) {
                MobileV2InputBehavior.STEER -> require(expectedActiveTurnId != null) {
                    "Steer requires expectedActiveTurnId"
                }
                MobileV2InputBehavior.FOLLOW_UP -> require(expectedActiveTurnId == null) {
                    "Follow Up must not carry expectedActiveTurnId"
                }
            }
            expectedActiveTurnId?.let {
                MobileV2ContractValidation.requireLegacyRunId(it, "expectedActiveTurnId")
            }
        }
    }

    @Serializable
    @SerialName("edit_follow_up")
    data class EditFollowUp(
        val id: String,
        val conversationId: String,
        val inputId: String,
        val expectedRevision: Long,
        val text: String,
        val images: List<
            @Serializable(with = MobileV2StrictImageSerializer::class) WsMessageImage,
        >? = null,
    ) : MobileV2WsClientFrame {
        init {
            requireMutationIdentity(id, conversationId, inputId)
            MobileV2ContractValidation.requireSafeInteger(
                expectedRevision,
                field = "expectedRevision",
            )
            MobileV2ContractValidation.requireImages(images, "images")
        }
    }

    @Serializable
    @SerialName("remove_follow_up")
    data class RemoveFollowUp(
        val id: String,
        val conversationId: String,
        val inputId: String,
        val expectedRevision: Long,
    ) : MobileV2WsClientFrame {
        init {
            requireMutationIdentity(id, conversationId, inputId)
            MobileV2ContractValidation.requireSafeInteger(
                expectedRevision,
                field = "expectedRevision",
            )
        }
    }

    @Serializable
    @SerialName("resume_follow_ups")
    data class ResumeFollowUps(
        val id: String,
        val conversationId: String,
        val expectedQueueRevision: Long,
    ) : MobileV2WsClientFrame {
        init {
            MobileV2ContractValidation.requireCanonicalUuid(id, "id")
            MobileV2ContractValidation.requireConversationIdentifier(
                conversationId,
                "conversationId",
            )
            MobileV2ContractValidation.requireSafeInteger(
                expectedQueueRevision,
                field = "expectedQueueRevision",
            )
        }
    }

    @Serializable
    @SerialName("answer")
    data class Answer(
        val id: String,
        val questionId: String,
        val answer: String,
    ) : MobileV2WsClientFrame {
        init {
            MobileV2ContractValidation.requireLegacyRunId(id, "id")
            MobileV2ContractValidation.requireNonEmpty(questionId, "questionId")
        }
    }

    @Serializable
    @SerialName("cancel")
    data class Cancel(val id: String) : MobileV2WsClientFrame {
        init {
            MobileV2ContractValidation.requireLegacyRunId(id, "id")
        }
    }
}

@Serializable(with = MobileV2ControlFrameSerializer::class)
sealed interface MobileV2ControlFrame : MobileV2WsServerFrame {
    @Serializable
    @SerialName("hello_ack")
    data class HelloAck(
        val contractVersion: Int,
        val capabilities: List<String>,
    ) : MobileV2ControlFrame {
        init {
            require(contractVersion == 2)
            MobileV2ContractValidation.requireCapabilities(capabilities, "capabilities")
        }
    }

    @Serializable
    @SerialName("conversation_subscribed")
    data class ConversationSubscribed(
        val id: String,
        val conversationId: String,
        val v2ThroughSeq: Long,
    ) : MobileV2ControlFrame {
        init {
            MobileV2ContractValidation.requireCanonicalUuid(id, "id")
            MobileV2ContractValidation.requireConversationIdentifier(
                conversationId,
                "conversationId",
            )
            MobileV2ContractValidation.requireSafeInteger(v2ThroughSeq, field = "v2ThroughSeq")
        }
    }

    @Serializable
    @SerialName("command_rejected")
    data class CommandRejected(
        val id: String,
        val conversationId: String? = null,
        val code: MobileApiErrorCode,
        val error: String,
        val retryable: Boolean,
        val details: JsonObject? = null,
    ) : MobileV2ControlFrame {
        init {
            MobileV2ContractValidation.requireLegacyRunId(id, "id")
            conversationId?.let {
                MobileV2ContractValidation.requireConversationIdentifier(it, "conversationId")
            }
            MobileV2ContractValidation.requireNonEmpty(error, "error")
        }
    }
}

@Serializable(with = MobileV2SequencedFrameSerializer::class)
sealed interface MobileV2SequencedFrame : MobileV2WsServerFrame {
    val v2Seq: Long

    @Serializable
    @SerialName("accepted")
    data class Accepted(
        val id: String,
        val conversationId: String,
        val runId: String,
        val segmentTurnId: String,
        override val v2Seq: Long,
        val userMessageId: String,
        val assistantMessageId: String,
        val revision: Long,
        val origin: MobileV2ConversationOrigin? = null,
        val kind: MobileV2ConversationKind? = null,
        val requestId: String? = null,
    ) : MobileV2SequencedFrame {
        init {
            requireRunFrame(id, conversationId, runId, segmentTurnId, v2Seq)
            MobileV2ContractValidation.requireCanonicalUuid(userMessageId, "userMessageId")
            MobileV2ContractValidation.requireCanonicalUuid(assistantMessageId, "assistantMessageId")
            MobileV2ContractValidation.requireSafeInteger(revision, field = "revision")
            requestId?.let {
                MobileV2ContractValidation.requireCodePointLength(it, 1, 256, "requestId")
            }
        }
    }

    @Serializable
    @SerialName("event")
    data class Event(
        val id: String,
        val conversationId: String,
        val runId: String,
        val segmentTurnId: String,
        override val v2Seq: Long,
        @Serializable(with = MobileV2StrictAgentEventSerializer::class)
        val event: AgentEvent,
    ) : MobileV2SequencedFrame {
        init {
            requireRunFrame(id, conversationId, runId, segmentTurnId, v2Seq)
        }
    }

    @Serializable
    @SerialName("done")
    data class Done(
        val id: String,
        val conversationId: String,
        val runId: String,
        val segmentTurnId: String,
        override val v2Seq: Long,
        val outcome: MobileV2TerminalOutcome,
    ) : MobileV2SequencedFrame {
        init {
            requireRunFrame(id, conversationId, runId, segmentTurnId, v2Seq)
        }
    }

    @Serializable
    @SerialName("error")
    data class Error(
        val id: String,
        val conversationId: String,
        val runId: String,
        val segmentTurnId: String,
        override val v2Seq: Long,
        val error: String,
        val code: MobileApiErrorCode? = null,
        val retryable: Boolean? = null,
    ) : MobileV2SequencedFrame {
        init {
            requireRunFrame(id, conversationId, runId, segmentTurnId, v2Seq)
            MobileV2ContractValidation.requireNonEmpty(error, "error")
        }
    }

    @Serializable
    @SerialName("input_accepted")
    data class InputAccepted(
        val id: String,
        val conversationId: String,
        override val v2Seq: Long,
        val queueRevision: Long,
        val input: MobileV2PendingInput,
    ) : MobileV2SequencedFrame {
        init {
            requireInputFrame(id, conversationId, v2Seq, queueRevision)
        }
    }

    @Serializable
    @SerialName("input_updated")
    data class InputUpdated(
        val id: String,
        val conversationId: String,
        override val v2Seq: Long,
        val queueRevision: Long,
        val input: MobileV2PendingInput,
    ) : MobileV2SequencedFrame {
        init {
            requireInputFrame(id, conversationId, v2Seq, queueRevision)
        }
    }

    @Serializable
    @SerialName("input_removed")
    data class InputRemoved(
        val id: String,
        val conversationId: String,
        override val v2Seq: Long,
        val queueRevision: Long,
        val input: MobileV2PendingInput,
    ) : MobileV2SequencedFrame {
        init {
            requireInputFrame(id, conversationId, v2Seq, queueRevision)
        }
    }

    @Serializable
    @SerialName("input_failed")
    data class InputFailed(
        val id: String,
        val conversationId: String,
        override val v2Seq: Long,
        val queueRevision: Long,
        val input: MobileV2PendingInput,
    ) : MobileV2SequencedFrame {
        init {
            requireInputFrame(id, conversationId, v2Seq, queueRevision)
        }
    }

    @Serializable
    @SerialName("input_delivered")
    data class InputDelivered(
        val id: String,
        val conversationId: String,
        override val v2Seq: Long,
        val queueRevision: Long,
        val input: MobileV2PendingInput,
        val runId: String,
        val segmentTurnId: String,
        val userMessageId: String,
        val assistantMessageId: String,
    ) : MobileV2SequencedFrame {
        init {
            requireInputFrame(id, conversationId, v2Seq, queueRevision)
            MobileV2ContractValidation.requireLegacyRunId(runId, "runId")
            MobileV2ContractValidation.requireCanonicalUuid(segmentTurnId, "segmentTurnId")
            MobileV2ContractValidation.requireCanonicalUuid(userMessageId, "userMessageId")
            MobileV2ContractValidation.requireCanonicalUuid(assistantMessageId, "assistantMessageId")
        }
    }

    @Serializable
    @SerialName("queue_paused")
    data class QueuePaused(
        val id: String? = null,
        val conversationId: String,
        override val v2Seq: Long,
        val queueRevision: Long,
        val queuePaused: Boolean,
        val pendingFollowUpCount: Long,
    ) : MobileV2SequencedFrame {
        init {
            requireQueueFrame(id, conversationId, v2Seq, queueRevision, pendingFollowUpCount)
        }
    }

    @Serializable
    @SerialName("queue_resumed")
    data class QueueResumed(
        val id: String? = null,
        val conversationId: String,
        override val v2Seq: Long,
        val queueRevision: Long,
        val queuePaused: Boolean,
        val pendingFollowUpCount: Long,
    ) : MobileV2SequencedFrame {
        init {
            requireQueueFrame(id, conversationId, v2Seq, queueRevision, pendingFollowUpCount)
        }
    }
}

@Serializable(with = MobileV2WsServerFrameSerializer::class)
sealed interface MobileV2WsServerFrame

object MobileV2WsClientFrameSerializer : KSerializer<MobileV2WsClientFrame> {
    override val descriptor: SerialDescriptor = JsonObject.serializer().descriptor

    override fun deserialize(decoder: Decoder): MobileV2WsClientFrame {
        val input = decoder.requireJsonDecoder()
        val frame = input.decodeFrameObject()
        return decodeClientFrame(input.json, frame, frame.requiredFrameType())
    }

    override fun serialize(encoder: Encoder, value: MobileV2WsClientFrame) {
        val output = encoder.requireJsonEncoder()
        output.encodeJsonElement(encodeClientFrame(output.json, value))
    }
}

object MobileV2ControlFrameSerializer : KSerializer<MobileV2ControlFrame> {
    override val descriptor: SerialDescriptor = JsonObject.serializer().descriptor

    override fun deserialize(decoder: Decoder): MobileV2ControlFrame {
        val input = decoder.requireJsonDecoder()
        val frame = input.decodeFrameObject()
        return decodeControlFrame(input.json, frame, frame.requiredFrameType())
    }

    override fun serialize(encoder: Encoder, value: MobileV2ControlFrame) {
        val output = encoder.requireJsonEncoder()
        output.encodeJsonElement(encodeControlFrame(output.json, value))
    }
}

object MobileV2SequencedFrameSerializer : KSerializer<MobileV2SequencedFrame> {
    override val descriptor: SerialDescriptor = JsonObject.serializer().descriptor

    override fun deserialize(decoder: Decoder): MobileV2SequencedFrame {
        val input = decoder.requireJsonDecoder()
        val frame = input.decodeFrameObject()
        return decodeSequencedFrame(input.json, frame, frame.requiredFrameType())
    }

    override fun serialize(encoder: Encoder, value: MobileV2SequencedFrame) {
        val output = encoder.requireJsonEncoder()
        output.encodeJsonElement(encodeSequencedFrame(output.json, value))
    }
}

object MobileV2WsServerFrameSerializer : KSerializer<MobileV2WsServerFrame> {
    override val descriptor: SerialDescriptor = JsonObject.serializer().descriptor

    override fun deserialize(decoder: Decoder): MobileV2WsServerFrame {
        val input = decoder.requireJsonDecoder()
        val frame = input.decodeFrameObject()
        val type = frame.requiredFrameType()
        return if (type in CONTROL_TYPES) {
            decodeControlFrame(input.json, frame, type)
        } else {
            decodeSequencedFrame(input.json, frame, type)
        }
    }

    override fun serialize(encoder: Encoder, value: MobileV2WsServerFrame) {
        val output = encoder.requireJsonEncoder()
        val frame = when (value) {
            is MobileV2ControlFrame -> encodeControlFrame(output.json, value)
            is MobileV2SequencedFrame -> encodeSequencedFrame(output.json, value)
        }
        output.encodeJsonElement(frame)
    }
}

private fun decodeClientFrame(json: Json, frame: JsonObject, type: String): MobileV2WsClientFrame =
    when (type) {
        "hello" -> json.decodeFrame(frame, MobileV2WsClientFrame.Hello.serializer())
        "subscribe_conversation" ->
            json.decodeFrame(frame, MobileV2WsClientFrame.SubscribeConversation.serializer())
        "message" -> json.decodeFrame(frame, MobileV2WsClientFrame.Message.serializer())
        "enqueue_input" -> json.decodeFrame(frame, MobileV2WsClientFrame.EnqueueInput.serializer())
        "edit_follow_up" -> json.decodeFrame(frame, MobileV2WsClientFrame.EditFollowUp.serializer())
        "remove_follow_up" ->
            json.decodeFrame(frame, MobileV2WsClientFrame.RemoveFollowUp.serializer())
        "resume_follow_ups" ->
            json.decodeFrame(frame, MobileV2WsClientFrame.ResumeFollowUps.serializer())
        "answer" -> json.decodeFrame(frame, MobileV2WsClientFrame.Answer.serializer())
        "cancel" -> json.decodeFrame(frame, MobileV2WsClientFrame.Cancel.serializer())
        else -> throw SerializationException("Unknown mobile v2 client frame type: $type")
    }.also { frame.validateFrameNulls() }

private fun encodeClientFrame(json: Json, value: MobileV2WsClientFrame): JsonObject = when (value) {
    is MobileV2WsClientFrame.Hello ->
        json.encodeFrame("hello", MobileV2WsClientFrame.Hello.serializer(), value)
    is MobileV2WsClientFrame.SubscribeConversation ->
        json.encodeFrame(
            "subscribe_conversation",
            MobileV2WsClientFrame.SubscribeConversation.serializer(),
            value,
        )
    is MobileV2WsClientFrame.Message ->
        json.encodeFrame("message", MobileV2WsClientFrame.Message.serializer(), value)
    is MobileV2WsClientFrame.EnqueueInput ->
        json.encodeFrame("enqueue_input", MobileV2WsClientFrame.EnqueueInput.serializer(), value)
    is MobileV2WsClientFrame.EditFollowUp ->
        json.encodeFrame("edit_follow_up", MobileV2WsClientFrame.EditFollowUp.serializer(), value)
    is MobileV2WsClientFrame.RemoveFollowUp ->
        json.encodeFrame(
            "remove_follow_up",
            MobileV2WsClientFrame.RemoveFollowUp.serializer(),
            value,
        )
    is MobileV2WsClientFrame.ResumeFollowUps ->
        json.encodeFrame(
            "resume_follow_ups",
            MobileV2WsClientFrame.ResumeFollowUps.serializer(),
            value,
        )
    is MobileV2WsClientFrame.Answer ->
        json.encodeFrame("answer", MobileV2WsClientFrame.Answer.serializer(), value)
    is MobileV2WsClientFrame.Cancel ->
        json.encodeFrame("cancel", MobileV2WsClientFrame.Cancel.serializer(), value)
}

private fun decodeControlFrame(json: Json, frame: JsonObject, type: String): MobileV2ControlFrame =
    when (type) {
        "hello_ack" -> json.decodeFrame(frame, MobileV2ControlFrame.HelloAck.serializer())
        "conversation_subscribed" ->
            json.decodeFrame(frame, MobileV2ControlFrame.ConversationSubscribed.serializer())
        "command_rejected" ->
            json.decodeFrame(frame, MobileV2ControlFrame.CommandRejected.serializer())
        else -> throw SerializationException("Unknown mobile v2 control frame type: $type")
    }.also { frame.validateFrameNulls() }

private fun encodeControlFrame(json: Json, value: MobileV2ControlFrame): JsonObject = when (value) {
    is MobileV2ControlFrame.HelloAck ->
        json.encodeFrame("hello_ack", MobileV2ControlFrame.HelloAck.serializer(), value)
    is MobileV2ControlFrame.ConversationSubscribed ->
        json.encodeFrame(
            "conversation_subscribed",
            MobileV2ControlFrame.ConversationSubscribed.serializer(),
            value,
        )
    is MobileV2ControlFrame.CommandRejected ->
        json.encodeFrame(
            "command_rejected",
            MobileV2ControlFrame.CommandRejected.serializer(),
            value,
        )
}

private fun decodeSequencedFrame(
    json: Json,
    frame: JsonObject,
    type: String,
): MobileV2SequencedFrame = when (type) {
    "accepted" -> json.decodeFrame(frame, MobileV2SequencedFrame.Accepted.serializer())
    "event" -> json.decodeFrame(frame, MobileV2SequencedFrame.Event.serializer())
    "done" -> json.decodeFrame(frame, MobileV2SequencedFrame.Done.serializer())
    "error" -> json.decodeFrame(frame, MobileV2SequencedFrame.Error.serializer())
    "input_accepted" -> json.decodeFrame(frame, MobileV2SequencedFrame.InputAccepted.serializer())
    "input_updated" -> json.decodeFrame(frame, MobileV2SequencedFrame.InputUpdated.serializer())
    "input_removed" -> json.decodeFrame(frame, MobileV2SequencedFrame.InputRemoved.serializer())
    "input_delivered" -> json.decodeFrame(frame, MobileV2SequencedFrame.InputDelivered.serializer())
    "input_failed" -> json.decodeFrame(frame, MobileV2SequencedFrame.InputFailed.serializer())
    "queue_paused" -> json.decodeFrame(frame, MobileV2SequencedFrame.QueuePaused.serializer())
    "queue_resumed" -> json.decodeFrame(frame, MobileV2SequencedFrame.QueueResumed.serializer())
    else -> throw SerializationException("Unknown mobile v2 sequenced frame type: $type")
}.also { frame.validateFrameNulls() }

private fun encodeSequencedFrame(json: Json, value: MobileV2SequencedFrame): JsonObject =
    when (value) {
        is MobileV2SequencedFrame.Accepted ->
            json.encodeFrame("accepted", MobileV2SequencedFrame.Accepted.serializer(), value)
        is MobileV2SequencedFrame.Event ->
            json.encodeFrame("event", MobileV2SequencedFrame.Event.serializer(), value)
        is MobileV2SequencedFrame.Done ->
            json.encodeFrame("done", MobileV2SequencedFrame.Done.serializer(), value)
        is MobileV2SequencedFrame.Error ->
            json.encodeFrame("error", MobileV2SequencedFrame.Error.serializer(), value)
        is MobileV2SequencedFrame.InputAccepted ->
            json.encodeFrame(
                "input_accepted",
                MobileV2SequencedFrame.InputAccepted.serializer(),
                value,
            )
        is MobileV2SequencedFrame.InputUpdated ->
            json.encodeFrame(
                "input_updated",
                MobileV2SequencedFrame.InputUpdated.serializer(),
                value,
            )
        is MobileV2SequencedFrame.InputRemoved ->
            json.encodeFrame(
                "input_removed",
                MobileV2SequencedFrame.InputRemoved.serializer(),
                value,
            )
        is MobileV2SequencedFrame.InputDelivered ->
            json.encodeFrame(
                "input_delivered",
                MobileV2SequencedFrame.InputDelivered.serializer(),
                value,
            )
        is MobileV2SequencedFrame.InputFailed ->
            json.encodeFrame(
                "input_failed",
                MobileV2SequencedFrame.InputFailed.serializer(),
                value,
            )
        is MobileV2SequencedFrame.QueuePaused ->
            json.encodeFrame(
                "queue_paused",
                MobileV2SequencedFrame.QueuePaused.serializer(),
                value,
            )
        is MobileV2SequencedFrame.QueueResumed ->
            json.encodeFrame(
                "queue_resumed",
                MobileV2SequencedFrame.QueueResumed.serializer(),
                value,
            )
    }

private fun requireMutationIdentity(id: String, conversationId: String, inputId: String) {
    MobileV2ContractValidation.requireCanonicalUuid(id, "id")
    MobileV2ContractValidation.requireConversationIdentifier(conversationId, "conversationId")
    MobileV2ContractValidation.requireCanonicalUuid(inputId, "inputId")
}

private fun requireRunFrame(
    id: String,
    conversationId: String,
    runId: String,
    segmentTurnId: String,
    v2Seq: Long,
) {
    MobileV2ContractValidation.requireLegacyRunId(id, "id")
    MobileV2ContractValidation.requireConversationIdentifier(conversationId, "conversationId")
    MobileV2ContractValidation.requireLegacyRunId(runId, "runId")
    MobileV2ContractValidation.requireLegacyRunId(segmentTurnId, "segmentTurnId")
    require(id == runId) { "Sequenced model frame id must equal runId" }
    MobileV2ContractValidation.requireSafeInteger(v2Seq, field = "v2Seq")
}

private fun requireInputFrame(
    id: String,
    conversationId: String,
    v2Seq: Long,
    queueRevision: Long,
) {
    MobileV2ContractValidation.requireCanonicalUuid(id, "id")
    MobileV2ContractValidation.requireConversationIdentifier(conversationId, "conversationId")
    MobileV2ContractValidation.requireSafeInteger(v2Seq, field = "v2Seq")
    MobileV2ContractValidation.requireSafeInteger(queueRevision, field = "queueRevision")
}

private fun requireQueueFrame(
    id: String?,
    conversationId: String,
    v2Seq: Long,
    queueRevision: Long,
    pendingFollowUpCount: Long,
) {
    id?.let { MobileV2ContractValidation.requireCanonicalUuid(it, "id") }
    MobileV2ContractValidation.requireConversationIdentifier(conversationId, "conversationId")
    MobileV2ContractValidation.requireSafeInteger(v2Seq, field = "v2Seq")
    MobileV2ContractValidation.requireSafeInteger(queueRevision, field = "queueRevision")
    MobileV2ContractValidation.requireSafeInteger(
        pendingFollowUpCount,
        field = "pendingFollowUpCount",
    )
}

private val CONTROL_TYPES = setOf("hello_ack", "conversation_subscribed", "command_rejected")

private fun Decoder.requireJsonDecoder(): JsonDecoder = this as? JsonDecoder
    ?: throw SerializationException("Mobile v2 frames require JSON")

private fun Encoder.requireJsonEncoder(): JsonEncoder = this as? JsonEncoder
    ?: throw SerializationException("Mobile v2 frames require JSON")

private fun JsonDecoder.decodeFrameObject(): JsonObject = decodeJsonElement() as? JsonObject
    ?: throw SerializationException("Mobile v2 frame must be an object")

private fun JsonObject.requiredFrameType(): String {
    val primitive = this["type"] as? JsonPrimitive
        ?: throw SerializationException("Mobile v2 frame requires type")
    if (!primitive.isString || primitive.content.isEmpty()) {
        throw SerializationException("Mobile v2 frame type must be a nonempty string")
    }
    return primitive.content
}

private fun JsonObject.payloadWithoutType(): JsonObject = JsonObject(filterKeys { it != "type" })

private fun JsonObject.validateFrameNulls() {
    forEach { (key, value) ->
        if (value is JsonNull) {
            throw SerializationException("Mobile v2 frame field $key may be omitted but not null")
        }
    }
    (this["location"] as? JsonObject)?.let { location ->
        location.forEach { (key, value) ->
            if (value is JsonNull) {
                throw SerializationException("Mobile v2 location field $key may not be null")
            }
        }
        (location["precise"] as? JsonObject)?.forEach { (key, value) ->
            if (value is JsonNull) {
                throw SerializationException("Mobile v2 precise-location field $key may not be null")
            }
        }
    }
}

private fun <T> Json.decodeFrame(frame: JsonObject, serializer: KSerializer<T>): T =
    decodeFromJsonElement(serializer, frame.payloadWithoutType())

private fun <T> Json.encodeFrame(
    type: String,
    serializer: KSerializer<T>,
    value: T,
): JsonObject {
    val payload = encodeToJsonElement(serializer, value) as? JsonObject
        ?: throw SerializationException("Mobile v2 frame payload must be an object")
    return buildJsonObject {
        put("type", type)
        payload.forEach { (key, element) -> put(key, element) }
    }
}
