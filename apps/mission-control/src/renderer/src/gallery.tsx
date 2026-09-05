/**
 * Dev-only tool-card gallery for Mission Control.
 *
 *   npx vite --root apps/mission-control/src/renderer --port 5200
 *   http://localhost:5200/gallery.html
 *
 * Why this exists: across two rounds of tool-use UX work this client was the
 * only surface never looked at. iOS has `capture-surfaces.sh` and its debug
 * launch options, web has `apps/web/gallery.html` — MC's chat needs an Electron
 * shell, a gateway and a live conversation, so every claim about it rested on
 * assertions. It renders `ToolBlock` directly, which takes plain props and
 * touches no store or IPC, against THE SAME fixtures the other two galleries
 * use, so all three clients can be compared per tool type.
 *
 * Not part of `electron-vite build` — that builds index.html and
 * companion.html. Dev-server only.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './assets/main.css';
import { ToolBlock } from './routes/chat.js';

interface Case {
  name: string;
  input: unknown;
  result: string;
  isError?: boolean;
  details?: unknown;
}

const BATCHES: { title: string; cases: Case[] }[] = [
  {
    title: 'files — read / write / edit',
    cases: [
      {
        name: 'read',
        input: { path: 'apps/web/src/ui/blocks/tool-presentation.ts' },
        result:
          "<path>apps/web/src/ui/blocks/tool-presentation.ts</path>\n<content>\n   1\texport function normalizeTool(name: string): string {\n   2\t  switch (name) {\n   3\t    case 'read_file':\n   4\t      return 'read';\n   5\t    default:\n   6\t      return name;\n   7\t  }\n   8\t}\n</content>",
      },
      {
        name: 'write',
        input: { path: 'docs/notes.md', content: '# Notes\n\nFirst line.\nSecond line.\n' },
        result: 'Wrote 4 lines to docs/notes.md',
      },
      {
        name: 'edit',
        input: { path: 'apps/web/src/ui/blocks/ContentBlocks.tsx' },
        result: 'ok',
        details: {
          diff: '--- a/apps/web/src/ui/blocks/ContentBlocks.tsx\n+++ b/apps/web/src/ui/blocks/ContentBlocks.tsx\n@@ -12,7 +12,8 @@\n   const summary = summarize(tool.name, tool.input);\n-  const details = formatVisibleDetails(tool.name, tool.input);\n+  const outcome = resultSummary(tool.name, result?.content);\n+  const details = formatVisibleDetails(tool.name, tool.input);',
        },
      },
    ],
  },
  {
    title: 'shell — bash / bash with no output / ls',
    cases: [
      {
        name: 'bash',
        input: { command: '/opt/homebrew/bin/npm run lint' },
        result:
          '> dash@0.2.0 lint\n> biome check .\n\nChecked 942 files in 609ms. No fixes applied.',
      },
      { name: 'bash', input: { command: 'mkdir -p build/captures' }, result: '' },
      {
        name: 'ls',
        input: { path: 'apps/web/src' },
        result: '(5 entries)\nui/\nintegration/\nmain.tsx\nstyles.css\nvite-env.d.ts',
      },
    ],
  },
  {
    title: 'search — grep / web_search / web_fetch',
    cases: [
      {
        name: 'grep',
        input: { pattern: 'resultSummary' },
        result:
          'apps/web/src/ui/blocks/tool-presentation.ts:214: export function resultSummary(\napps/web/src/ui/blocks/ContentBlocks.tsx:191:  const outcome = resultSummary(\nios/Dash/Features/Conversations/ToolPresentation.swift:318:  static func resultSummary(',
      },
      {
        name: 'web_search',
        input: { query: 'swiftui observable macro' },
        result:
          '1. [Observation | Apple Developer](https://developer.apple.com/documentation/observation)\n   The Observation framework provides a robust, type-safe model.\n\n2. [Migrating to the Observable macro](https://developer.apple.com/videos/wwdc)\n   Replace ObservableObject with the @Observable macro.',
      },
      {
        // The regression case: 1.6 KB on ONE line. Before `fitsInline` this
        // counted as a "short" result and rendered with no height cap.
        name: 'web_fetch',
        input: { url: 'https://developer.apple.com/documentation/observation' },
        result: 'Observation framework documentation body. '.repeat(40),
      },
    ],
  },
  {
    title: 'meta — TodoWrite / load_skill / an MCP tool / failed',
    cases: [
      {
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'Port resultSummary to iOS', status: 'completed' },
            { content: 'Audit each tool type from a rendered screen', status: 'in_progress' },
            { content: 'Write the per-type design', status: 'pending' },
          ],
        },
        result: 'ok',
      },
      {
        name: 'load_skill',
        input: { name: 'frontend-design' },
        result: "Loaded skill 'frontend-design'.",
      },
      {
        name: 'linear__search_issues',
        input: { query: 'tool card', limit: 5, filter: { state: 'open' } },
        result: 'DASH-412  Tool rows unreadable\nDASH-418  Diff not rendered on iOS',
      },
      {
        name: 'read',
        input: { path: '/Users/gerry/missing.swift' },
        result: 'ENOENT: no such file or directory',
        isError: true,
      },
    ],
  },
];

function Gallery(): JSX.Element {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-1 text-lg font-semibold">Mission Control — tool-card gallery</h1>
      <p className="mb-6 text-xs text-muted">
        Same fixtures as the iOS and web galleries. Click a header to expand a card.
      </p>
      {BATCHES.map((batch) => (
        <section key={batch.title} className="mb-8">
          <h2 className="mb-2 text-[11px] uppercase tracking-wide text-muted">{batch.title}</h2>
          {batch.cases.map((c, index) => (
            <ToolBlock
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, immutable fixture list
              key={`${c.name}-${index}`}
              name={c.name}
              input={JSON.stringify(c.input)}
              result={c.result}
              isError={c.isError}
              toolDetails={c.details}
            />
          ))}
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
