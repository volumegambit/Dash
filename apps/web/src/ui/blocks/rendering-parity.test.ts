import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatVisibleDetails, middleTruncate, summarize, toolLabel } from './tool-presentation.js';

// Cross-platform rendering-parity fixtures (Task 5, output-rendering plan).
//
// scripts/fixtures/rendering-fixtures.json is the single source of truth for
// tool-presentation.ts (this file's target) and its iOS twin,
// ios/Dash/Features/Conversations/ToolPresentation.swift, asserted against
// by ios/DashTests/Features/RenderingParityTests.swift. Both consumers read
// the SAME JSON — if this file's expectations and the Swift test's
// expectations ever disagree, that's a real behavioral divergence, not a
// fixture-authoring mistake, because there's only one fixture to author.
//
// Read via fs + a repo-root-relative path (not a JSON module import) so this
// works identically under plain `vitest` and the root `npm test` runner
// without relying on import-assertion syntax support. Uses
// `import.meta.dirname` rather than `new URL(..., import.meta.url)` because
// this file runs under the happy-dom test environment (see
// environmentMatchGlobs in the root vitest.config.ts), whose global `URL`
// polyfill rejects `file:` schemes.
const fixturePath = join(
  import.meta.dirname,
  '../../../../../scripts/fixtures/rendering-fixtures.json',
);

interface LabelCase {
  name: string;
  kind: 'label';
  toolName: string;
  expectedLabel: string;
}

interface SummarizeCase {
  name: string;
  kind: 'summarize';
  toolName: string;
  input: Record<string, unknown>;
  expectedSummary: string | null;
}

interface TruncateCase {
  name: string;
  kind: 'truncate';
  input: string;
  expectedTruncated: string;
}

interface DetailsCase {
  name: string;
  kind: 'details';
  toolName: string;
  input: Record<string, unknown>;
  expectedDetails: { key: string; value: string }[];
}

type FixtureCase = LabelCase | SummarizeCase | TruncateCase | DetailsCase;

interface Fixture {
  cases: FixtureCase[];
}

const fixture: Fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));

// formatDetails/formatVisibleDetails key ORDER is a known acceptable
// divergence between platforms (JS insertion order vs Swift alphabetical
// sort — see tool-presentation.ts's module doc comment). Compare detail
// rows as a key-sorted list so that divergence can never cause a false
// failure here.
function sortedByKey(details: { key: string; value: string }[]) {
  return [...details].sort((a, b) => a.key.localeCompare(b.key));
}

const labelCases = fixture.cases.filter((c): c is LabelCase => c.kind === 'label');
const summarizeCases = fixture.cases.filter((c): c is SummarizeCase => c.kind === 'summarize');
const truncateCases = fixture.cases.filter((c): c is TruncateCase => c.kind === 'truncate');
const detailsCases = fixture.cases.filter((c): c is DetailsCase => c.kind === 'details');

describe('rendering parity fixtures', () => {
  it('loads a non-empty fixture with all four case kinds', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
    expect(labelCases.length).toBeGreaterThan(0);
    expect(summarizeCases.length).toBeGreaterThan(0);
    expect(truncateCases.length).toBeGreaterThan(0);
    expect(detailsCases.length).toBeGreaterThan(0);
  });

  describe.each(labelCases)('label: $name', (c) => {
    it('matches toolLabel', () => {
      expect(toolLabel(c.toolName)).toBe(c.expectedLabel);
    });
  });

  describe.each(summarizeCases)('summarize: $name', (c) => {
    it('matches summarize', () => {
      // Web's summarize() returns '' for "nothing to show"; the fixture
      // uses null as the shared "empty" sentinel across platforms.
      expect(summarize(c.toolName, c.input)).toBe(c.expectedSummary ?? '');
    });
  });

  describe.each(truncateCases)('truncate: $name', (c) => {
    it('matches middleTruncate', () => {
      expect(middleTruncate(c.input)).toBe(c.expectedTruncated);
    });
  });

  describe.each(detailsCases)('details: $name', (c) => {
    it('matches formatVisibleDetails', () => {
      expect(sortedByKey(formatVisibleDetails(c.toolName, c.input))).toEqual(
        sortedByKey(c.expectedDetails),
      );
    });
  });
});
