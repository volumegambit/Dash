import type { AgentEvent, ImageBlock, RunOptions } from './types.js';

/**
 * Thin protocol for "anything that can produce a stream of AgentEvents
 * given a user message". This is a plug point — the gateway wraps its
 * in-process `AgentChatCoordinator` behind this interface so that a remote-agent
 * implementation (e.g. an agent running in another process, or a
 * WebSocket-backed proxy) could be dropped in later without touching
 * `DynamicGateway`, `chat-server`, or channel adapters.
 *
 * There is deliberately no concrete implementation in this package.
 * Entry points (the gateway, the chat server, channel adapters under
 * test) construct small inline adapters that satisfy this interface.
 */
export interface AgentClient {
  chat(
    channelId: string,
    conversationId: string,
    text: string,
    options?: RunOptions & { images?: ImageBlock[] },
  ): AsyncGenerator<AgentEvent>;
  answerQuestion?(id: string, answers: string[][]): Promise<void>;
}
