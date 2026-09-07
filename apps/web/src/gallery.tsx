/**
 * Dev-only tool-card gallery — `npm run dev -w @dash/web`, then
 * http://localhost:5173/gallery.html
 *
 * Why this exists: the web client's tool rendering could not be looked at.
 * The real chat surface needs a gateway, an account and a live conversation,
 * so every claim about how a tool card reads on web was backed by assertions
 * against a DOM tree rather than by a rendered screen. The iOS twin has
 * `ios/scripts/capture-surfaces.sh` and its debug launch options; this is the
 * equivalent, and it deliberately uses THE SAME four batches of fixtures so
 * the two clients can be compared per tool type.
 *
 * Not wired into `vite build` — Vite only builds `index.html` unless a second
 * input is declared in `rollupOptions`, which it is not. Dev-server only.
 */
import type { MobileAgentEvent } from '@dash/mobile-contract';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { ContentBlocks } from './ui/blocks/ContentBlocks.js';

function start(id: string, name: string, input: Record<string, unknown>): MobileAgentEvent {
  return { type: 'tool_use_start', id, name, input };
}

function result(
  id: string,
  name: string,
  content: string,
  extra: { isError?: boolean; details?: unknown } = {},
): MobileAgentEvent {
  return { type: 'tool_result', id, name, content, ...extra };
}

const BATCHES: { title: string; events: MobileAgentEvent[] }[] = [
  {
    title: 'files — read / write / edit',
    events: [
      start('g-read', 'read', { path: 'apps/web/src/ui/blocks/tool-presentation.ts' }),
      result(
        'g-read',
        'read',
        "<path>apps/web/src/ui/blocks/tool-presentation.ts</path>\n<content>\n   1\texport function normalizeTool(name: string): string {\n   2\t  switch (name) {\n   3\t    case 'read_file':\n   4\t      return 'read';\n   5\t    default:\n   6\t      return name;\n   7\t  }\n   8\t}\n</content>",
      ),
      start('g-write', 'write', {
        path: 'docs/notes.md',
        content: '# Notes\n\nFirst line.\nSecond line.\n',
      }),
      result('g-write', 'write', 'Wrote 4 lines to docs/notes.md'),
      start('g-edit', 'edit', { path: 'apps/web/src/ui/blocks/ContentBlocks.tsx' }),
      result('g-edit', 'edit', 'ok', {
        details: {
          diff: '--- a/apps/web/src/ui/blocks/ContentBlocks.tsx\n+++ b/apps/web/src/ui/blocks/ContentBlocks.tsx\n@@ -12,7 +12,8 @@\n   const summary = summarize(tool.name, tool.input);\n-  const details = formatVisibleDetails(tool.name, tool.input);\n+  const outcome = resultSummary(tool.name, result?.content);\n+  const details = formatVisibleDetails(tool.name, tool.input);',
        },
      }),
    ],
  },
  {
    title: 'shell — bash / bash with no output / ls',
    events: [
      start('g-bash', 'bash', { command: '/opt/homebrew/bin/npm run lint' }),
      result(
        'g-bash',
        'bash',
        '> dash@0.2.0 lint\n> biome check .\n\nChecked 942 files in 609ms. No fixes applied.',
      ),
      start('g-quiet', 'bash', { command: 'mkdir -p build/captures' }),
      result('g-quiet', 'bash', ''),
      start('g-ls', 'ls', { path: 'apps/web/src' }),
      result('g-ls', 'ls', '(5 entries)\nui/\nintegration/\nmain.tsx\nstyles.css\nvite-env.d.ts'),
    ],
  },
  {
    title: 'search — grep / web_search / web_fetch',
    events: [
      start('g-grep', 'grep', { pattern: 'resultSummary' }),
      result(
        'g-grep',
        'grep',
        'apps/web/src/ui/blocks/tool-presentation.ts:214: export function resultSummary(\napps/web/src/ui/blocks/ContentBlocks.tsx:191:  const outcome = resultSummary(\nios/Dash/Features/Conversations/ToolPresentation.swift:318:  static func resultSummary(',
      ),
      start('g-search', 'web_search', { query: 'swiftui observable macro' }),
      result(
        'g-search',
        'web_search',
        '1. [Observation | Apple Developer](https://developer.apple.com/documentation/observation)\n   The Observation framework provides a robust, type-safe model.\n\n2. [Migrating to the Observable macro](https://developer.apple.com/videos/wwdc)\n   Replace ObservableObject with the @Observable macro.',
      ),
      start('g-fetch', 'web_fetch', {
        url: 'https://developer.apple.com/documentation/observation',
      }),
      result('g-fetch', 'web_fetch', 'Observation framework documentation body. '.repeat(40)),
    ],
  },
  {
    title: 'meta — TodoWrite / load_skill / an MCP tool / running / failed',
    events: [
      start('g-todo', 'TodoWrite', {
        todos: [
          { content: 'Port resultSummary to iOS', status: 'completed' },
          { content: 'Audit each tool type from a rendered screen', status: 'in_progress' },
          { content: 'Write the per-type design', status: 'pending' },
        ],
      }),
      result('g-todo', 'TodoWrite', 'ok'),
      start('g-skill', 'load_skill', { name: 'frontend-design' }),
      result('g-skill', 'load_skill', "Loaded skill 'frontend-design'."),
      start('g-mcp', 'linear__search_issues', {
        query: 'tool card',
        limit: 5,
        filter: { state: 'open' },
      }),
      result(
        'g-mcp',
        'linear__search_issues',
        'DASH-412  Tool rows unreadable\nDASH-418  Diff not rendered on iOS',
      ),
      start('g-fail', 'read', { path: '/Users/gerry/missing.swift' }),
      result('g-fail', 'read', 'ENOENT: no such file or directory', { isError: true }),
      start('g-run', 'bash', { command: 'npm test' }),
    ],
  },
];

let openedOnce = false;

function Gallery(): React.ReactNode {
  // `?open=1` expands every card, so the per-tool BODIES can be screenshotted.
  // The iOS twin does this with the `DASH_UI_TEST_EXPAND_TOOLS` launch option;
  // here a click is available, so clicking is simpler than threading a prop
  // through ContentBlocks purely for the gallery.
  //
  // The module-level guard is load-bearing under StrictMode, which invokes
  // effects twice back-to-back. The `aria-expanded` check is not enough on its
  // own: React has not re-rendered between the two invocations, so the second
  // pass still reads "false", clicks every header a second time, and closes
  // everything again. That is exactly what the first screenshot showed.
  useEffect(() => {
    if (openedOnce) return;
    if (!new URLSearchParams(window.location.search).has('open')) return;
    openedOnce = true;
    for (const header of document.querySelectorAll<HTMLButtonElement>('.tool-card-header')) {
      if (header.getAttribute('aria-expanded') === 'false') header.click();
    }
  }, []);

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Tool-card gallery</h1>
      <p style={{ opacity: 0.6, fontSize: 13, marginTop: 0 }}>
        Same fixtures as the iOS gallery (<code>DASH_UI_TEST_TOOL_GALLERY</code>). Cards render at
        their real default expansion — click a header to open one.
      </p>
      {BATCHES.map((batch) => (
        <section key={batch.title} style={{ marginTop: 28 }}>
          <h2
            style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.5 }}
          >
            {batch.title}
          </h2>
          <ContentBlocks content={{ type: 'assistant', events: batch.events }} />
        </section>
      ))}
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Gallery />
    </StrictMode>,
  );
}
