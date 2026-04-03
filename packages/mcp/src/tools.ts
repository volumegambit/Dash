import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TSchema } from '@sinclair/typebox';
import { NAMESPACE_SEPARATOR } from './types.js';

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

type CallToolFn = (
  name: string,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

interface McpToolDetails {
  isError?: boolean;
}

export function wrapMcpTool(
  serverName: string,
  def: McpToolDefinition,
  callTool: CallToolFn,
  toolTimeout: number,
): AgentTool<TSchema, McpToolDetails> {
  const namespacedName = `${serverName}${NAMESPACE_SEPARATOR}${def.name}`;

  return {
    name: namespacedName,
    label: `${serverName}: ${def.name}`,
    description: def.description ?? '',
    parameters: (def.inputSchema ?? { type: 'object', properties: {} }) as TSchema,
    execute: async (
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<McpToolDetails>> => {
      try {
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), toolTimeout);

        // Combine external signal with timeout signal
        const combinedSignal = signal
          ? AbortSignal.any([signal, timeoutController.signal])
          : timeoutController.signal;

        try {
          const result = await callTool(def.name, (params ?? {}) as Record<string, unknown>, {
            signal: combinedSignal,
          });
          clearTimeout(timeoutId);

          const content = (result.content ?? []).map((c) => ({
            type: 'text' as const,
            text: c.text ?? JSON.stringify(c),
          }));

          if (result.isError) {
            return { content, details: { isError: true } };
          }

          return { content, details: {} };
        } catch (err) {
          clearTimeout(timeoutId);
          throw err;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: 'text', text: `MCP tool error (${serverName}/${def.name}): ${message}` },
          ],
          details: { isError: true },
        };
      }
    },
  };
}
