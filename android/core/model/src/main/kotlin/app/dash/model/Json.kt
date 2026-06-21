package app.dash.model

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json

/**
 * Shared JSON configuration for all Dash wire types.
 *
 * Contract source of truth (TypeScript):
 *  - packages/agent/src/types.ts        (AgentEvent, content blocks)
 *  - apps/gateway/src/chat-ws.ts        (WsClientMessage / WsServerMessage — the
 *                                        live `/ws/chat` route, not the unmounted
 *                                        legacy packages/chat/src/chat-server.ts)
 *  - apps/gateway/src/agent-registry.ts (RegisteredAgent)
 *
 * Keep these DTOs in sync with those files. Unknown fields are ignored so the
 * app tolerates gateway additions without crashing, and unknown polymorphic
 * `type` discriminators decode to a neutral `Unknown` case (see AgentEvent).
 */
object DashJson {
    @OptIn(ExperimentalSerializationApi::class)
    val instance: Json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
        classDiscriminator = "type"
        explicitNulls = false
    }
}
