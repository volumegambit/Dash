import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const MAX_BYTES = 100 * 1024; // 100KB
const TIMEOUT_MS = 30_000;
const USER_AGENT = 'Dash-Agent/1.0 (web_fetch tool)';

const webFetchSchema = Type.Object({
  url: Type.String({ description: 'The URL to fetch' }),
});

type WebFetchInput = Static<typeof webFetchSchema>;

interface WebFetchDetails {
  isError?: boolean;
}

/**
 * Strip script and style tags (with content), then all remaining HTML tags,
 * decode common HTML entities, and collapse whitespace.
 */
function htmlToText(html: string): string {
  // Remove script and style blocks entirely (including content)
  let text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));

  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * Create the web_fetch tool.
 * Fetches content from a URL and returns the text content of the page.
 */
export function createWebFetchTool(): AgentTool<typeof webFetchSchema> {
  return {
    name: 'web_fetch',
    label: 'Web Fetch',
    description: 'Fetch content from a URL. Returns the text content of the page.',
    parameters: webFetchSchema,
    execute: async (
      _toolCallId: string,
      params: WebFetchInput,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<WebFetchDetails>> => {
      const errorResult = (message: string): AgentToolResult<WebFetchDetails> => ({
        content: [{ type: 'text', text: `Error: ${message}` }],
        details: { isError: true },
      });

      // Validate URL
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(params.url);
      } catch {
        return errorResult(`Invalid URL: ${params.url}`);
      }

      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return errorResult(
          `Unsupported protocol: ${parsedUrl.protocol}. Only http and https are supported.`,
        );
      }

      // Set up timeout via AbortController
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      // Combine with any caller-provided signal
      const combinedSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;

      try {
        const response = await fetch(params.url, {
          signal: combinedSignal,
          headers: {
            'User-Agent': USER_AGENT,
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          return errorResult(`HTTP ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') ?? '';
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        let truncated = false;
        let rawText: string;

        if (bytes.length > MAX_BYTES) {
          rawText = new TextDecoder().decode(bytes.slice(0, MAX_BYTES));
          truncated = true;
        } else {
          rawText = new TextDecoder().decode(bytes);
        }

        let text: string;
        if (contentType.includes('text/html')) {
          text = htmlToText(rawText);
        } else {
          // JSON, plain text, etc. — return as-is
          text = rawText;
        }

        if (truncated) {
          text += '\n\n[Response truncated at 100KB]';
        }

        return {
          content: [{ type: 'text', text }],
          details: {},
        };
      } catch (err: unknown) {
        clearTimeout(timeoutId);

        if (err instanceof Error) {
          if (err.name === 'AbortError') {
            return errorResult('Request timed out after 30 seconds');
          }
          return errorResult(err.message);
        }
        return errorResult(String(err));
      }
    },
  };
}
