import { useEffect, useState } from 'react';
import { AVAILABLE_TOOLS, TOOL_DESCRIPTIONS } from '../components/deploy-options.js';
import type { ToolOption } from '../components/deploy-options.js';

/** Pretty-print a tool ID as a label (e.g. "web_fetch" → "Web Fetch") */
function toolLabel(id: string): string {
  return id
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function useAvailableTools(): ToolOption[] {
  const [tools, setTools] = useState<ToolOption[]>(AVAILABLE_TOOLS);

  useEffect(() => {
    window.api
      .toolsList()
      .then((cached) => {
        // Filter out unknown tool IDs (e.g. "invalid" from the OpenCode SDK)
        const known = cached.filter((id) => id in TOOL_DESCRIPTIONS);
        if (known.length > 0) {
          setTools(
            known.map((id) => ({
              value: id,
              label: toolLabel(id),
              description: TOOL_DESCRIPTIONS[id],
            })),
          );
        }
      })
      .catch(() => {
        // Keep fallback AVAILABLE_TOOLS
      });
  }, []);

  return tools;
}
