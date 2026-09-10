const FENCE_RE = /^(```|~~~)/;
const HEADING_RE = /^#{1,6}\s+(.*)$/;
const BLOCKQUOTE_RE = /^>+\s?(.*)$/;
const ORDERED_ITEM_RE = /^\s*\d+[.)]\s+(.*)$/;
const BULLET_ITEM_RE = /^\s*[-*+]\s+(.*)$/;
const TERMINAL_PUNCTUATION_RE = /[.!?:]$/;

/** Emit triggers for `SentenceChunker`: sentence-ending punctuation followed by whitespace. */
const SENTENCE_BOUNDARY_CHARS = '.!?:';

const DEFAULT_MAX_CHARS = 280;

/** Private-use marker wrapping an inline-code placeholder index; vanishingly unlikely in real text. */
const CODE_PLACEHOLDER_MARK = '\uE000';
const CODE_PLACEHOLDER_RE = new RegExp(
  `${CODE_PLACEHOLDER_MARK}(\\d+)${CODE_PLACEHOLDER_MARK}`,
  'g',
);

/** Appends `.` unless `text` already ends with sentence-ending punctuation. */
function terminate(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return trimmed;
  return TERMINAL_PUNCTUATION_RE.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** True when `line` looks like a markdown table row: it contains a `|` and is non-blank. */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && trimmed.includes('|');
}

/** True when `line` is a markdown table's header/body separator row (e.g. `| --- | --- |`). */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') && !trimmed.includes('-')) return false;
  const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.length > 0 && cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

/**
 * Applies markdown inline formatting rules to a single logical piece of text:
 * inline code spans are replaced by their literal text, images by their alt
 * text (or "image"), links by their link text, emphasis/strikethrough markers
 * are dropped (keeping the inner text), and HTML tags are stripped.
 *
 * Inline code is extracted to placeholders first and restored last, so its
 * contents are immune to the emphasis/HTML passes that follow.
 */
function inline(text: string): string {
  const codeSpans: string[] = [];
  let result = text.replace(/`([^`]*)`/g, (_match, code: string) => {
    codeSpans.push(code);
    return `${CODE_PLACEHOLDER_MARK}${codeSpans.length - 1}${CODE_PLACEHOLDER_MARK}`;
  });

  result = result.replace(
    /!\[([^\]]*)\]\([^)]*\)/g,
    (_match, alt: string) => alt.trim() || 'image',
  );
  result = result.replace(/\[([^\]]*)\]\([^)]*\)/g, (_match, linkText: string) => linkText);
  result = result.replace(/(\*\*\*|___)([^*_]+)\1/g, '$2');
  result = result.replace(/(\*\*|__)([^*_]+)\1/g, '$2');
  result = result.replace(/(\*|_)([^*_]+)\1/g, '$2');
  result = result.replace(/~~([^~]+)~~/g, '$1');
  result = result.replace(/<[^>]+>/g, '');

  result = result.replace(CODE_PLACEHOLDER_RE, (_match, index: string) => codeSpans[Number(index)]);
  return result;
}

/**
 * Converts a chunk of markdown into plain, speakable text for text-to-speech.
 *
 * Handles fenced code blocks (replaced by "Code block omitted."), tables
 * (replaced by "Table with N rows omitted." for N data rows), headings, lists,
 * blockquotes, links, images, inline code, emphasis and HTML tags. Runs of
 * whitespace (including blank lines / paragraph breaks) collapse to a single
 * space, so paragraph structure is not preserved in the output — callers that
 * need paragraph-aware splitting should chunk before calling `speakable`, as
 * `SentenceChunker` does.
 */
export function speakable(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const fenceMarker = fenceMatch[1];
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith(fenceMarker)) j++;
      out.push('Code block omitted.');
      i = j < lines.length ? j + 1 : lines.length;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      let j = i + 2;
      let rowCount = 0;
      while (j < lines.length && isTableRow(lines[j])) {
        rowCount++;
        j++;
      }
      out.push(`Table with ${rowCount} row${rowCount === 1 ? '' : 's'} omitted.`);
      i = j;
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      out.push(terminate(inline(heading[1])));
      i++;
      continue;
    }

    const blockquote = line.match(BLOCKQUOTE_RE);
    if (blockquote) {
      out.push(inline(blockquote[1]));
      i++;
      continue;
    }

    const ordered = line.match(ORDERED_ITEM_RE);
    if (ordered) {
      out.push(terminate(inline(ordered[1])));
      i++;
      continue;
    }

    const bullet = line.match(BULLET_ITEM_RE);
    if (bullet) {
      out.push(terminate(inline(bullet[1])));
      i++;
      continue;
    }

    out.push(inline(line));
    i++;
  }

  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Finds the split point for the next emittable sentence in `text`, or `null`
 * if none is ready yet. Two rules, checked in order:
 *
 * 1. Sentence-ending punctuation (`.`, `!`, `?`, `:`) followed by whitespace —
 *    split right after the punctuation. Suppressed when the token immediately
 *    before the punctuation is a single letter, or single letters chained by
 *    dots (so "e.g. " doesn't split after either dot, and neither does
 *    "i.e. " or "U.S. "), or a digit-only run followed by another digit after
 *    the whitespace (so a reflowed decimal like "3. 5" doesn't split). This
 *    is a deliberately simple heuristic, not general abbreviation detection.
 * 2. If `text` exceeds `maxChars`, split at the last whitespace at or before
 *    `maxChars` so a sentence is never cut mid-word; if there is no
 *    whitespace to split on, split at `maxChars`.
 */
function findSplit(text: string, maxChars: number): number | null {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!SENTENCE_BOUNDARY_CHARS.includes(ch)) continue;
    if (!/\s/.test(text[i + 1] ?? '')) continue;
    if (isSuppressedBoundary(text, i)) continue;
    return i + 1;
  }

  if (text.length > maxChars) {
    const window = text.slice(0, maxChars);
    const lastSpace = window.lastIndexOf(' ');
    return lastSpace > 0 ? lastSpace + 1 : maxChars;
  }

  return null;
}

/**
 * See rule 1 in {@link findSplit}. `SentenceChunker` calls this on a buffer
 * that may still be growing character by character (real-time streaming), so
 * the digit-run check treats "we haven't seen what comes after the trigger
 * whitespace yet" as suppressed too — not knowing yet is not the same as
 * knowing it isn't a digit. If a non-digit does show up, the next character
 * append re-evaluates this same boundary and finds it no longer suppressed.
 */
function isSuppressedBoundary(text: string, punctuationIndex: number): boolean {
  let tokenStart = punctuationIndex;
  while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1])) tokenStart--;
  const precedingToken = text.slice(tokenStart, punctuationIndex);

  if (/^[A-Za-z](\.[A-Za-z])*$/.test(precedingToken)) return true;

  if (/^\d+$/.test(precedingToken)) {
    const afterWhitespace = text.slice(punctuationIndex + 1).replace(/^\s+/, '');
    if (afterWhitespace === '' || /^\d/.test(afterWhitespace)) return true;
  }

  return false;
}

/**
 * True when `buf` — the characters accumulated so far for the *current*
 * line — could still turn into a block-construct line opener (heading,
 * ordered/bullet list item, blockquote, fenced code, or a table row). Once
 * this goes false the line is committed as ordinary plain text for the rest
 * of the line (see `SentenceChunker`'s per-character dispatch).
 *
 * Blockquote, fence and table candidacy are "sticky": once their opening
 * character(s) are seen, they match for the rest of the line no matter what
 * follows (a blockquote/fence/table row can contain anything after its
 * opener). Heading/ordered/bullet candidacy is only sticky after the marker
 * is confirmed complete (hashes + a space, digits + `.`/`)` + a space, or the
 * bullet char + a space); before that they can still be disqualified.
 *
 * Table-row candidacy is deliberately narrowed to lines whose *first*
 * character is `|` (the common leading-pipe style, matching this package's
 * own fixtures) rather than "contains `|` anywhere" — a mid-line pipe can't
 * be distinguished from ordinary prose without holding the whole line, which
 * would defeat real-time plain-text emission for the overwhelming common
 * case of ordinary prose that happens to contain a `|` character.
 */
function isBlockCandidate(buf: string): boolean {
  if (buf.length === 0) return true;
  if (buf[0] === '|') return true;
  if (buf[0] === '>') return true;
  return (
    isHeadingCandidate(buf) ||
    isOrderedCandidate(buf) ||
    isBulletCandidate(buf) ||
    isFenceCandidate(buf)
  );
}

function isHeadingCandidate(buf: string): boolean {
  return /^#{0,6}$/.test(buf) || /^#{1,6}\s/.test(buf);
}

function isOrderedCandidate(buf: string): boolean {
  return /^\s*\d*$/.test(buf) || /^\s*\d+[.)]$/.test(buf) || /^\s*\d+[.)]\s/.test(buf);
}

function isBulletCandidate(buf: string): boolean {
  return /^\s*$/.test(buf) || /^\s*[-*+]$/.test(buf) || /^\s*[-*+]\s/.test(buf);
}

function isFenceCandidate(buf: string): boolean {
  const c = buf[0];
  if (c !== '`' && c !== '~') return false;
  if (buf.length >= 3) return buf[1] === c && buf[2] === c;
  for (let i = 1; i < buf.length; i++) if (buf[i] !== c) return false;
  return true;
}

export interface SentenceChunkerOptions {
  /** Maximum sentence length before a forced split at the last whitespace. Default 280. */
  maxChars?: number;
}

type LineMode = 'undetermined' | 'plain';
type TableState = 'none' | 'pendingHeader' | 'inTable';

/**
 * Turns a streamed markdown reply into speakable sentences, one at a time,
 * for per-sentence text-to-speech, emitting as early as the content allows
 * rather than waiting for the whole reply (or even a whole paragraph):
 *
 * 1. **Plain text** is scanned in real time, character by character. As soon
 *    as the buffered text contains a sentence-ending trigger (`.`, `!`, `?`,
 *    `:` followed by whitespace — see `findSplit` for the decimal/
 *    abbreviation suppression rule) or exceeds `maxChars`, that sentence is
 *    sliced off, run through `speakable` (for inline transforms — emphasis,
 *    links, inline code, HTML), and emitted immediately.
 * 2. **Block-construct lines** — headings, list items, and blockquotes — are
 *    classified from their first character(s) (see `isBlockCandidate`) and,
 *    once classified, held until their own line completes (a `\n`), at which
 *    point the whole line is rendered via `speakable` and emitted as one
 *    sentence — never split at punctuation inside it. A **table** is a
 *    multi-line block: consecutive `|`-led rows are held (nothing emitted)
 *    until the table ends — a non-table-row line, a blank line, or
 *    `flush()` — at which point one `"Table with N rows omitted."` sentence
 *    is emitted for the whole table.
 * 3. A **blank line** or `flush()` force-emits whatever plain text is still
 *    buffered, even without trailing punctuation, and resolves any
 *    in-progress table. A **fenced code block** (opened by a line starting
 *    with three backticks or tildes) holds everything of its own content —
 *    nothing is emitted from inside it — until the matching fence closes or
 *    `flush()`, at which point it collapses to one `"Code block omitted."`
 *    sentence. Plain-text sentences before or after a fence in the same
 *    paragraph are unaffected by the fence and follow rule 1 as normal.
 */
export class SentenceChunker {
  private readonly maxChars: number;

  private lineMode: LineMode = 'undetermined';
  private lineBuffer = '';
  private plainBuffer = '';

  private fenceOpen = false;
  private fenceMarker = '';

  private tableState: TableState = 'none';
  private pendingHeaderLine = '';
  private tableRowCount = 0;

  constructor(options: SentenceChunkerOptions = {}) {
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  }

  push(delta: string): string[] {
    const emitted: string[] = [];
    for (const ch of delta) {
      if (this.fenceOpen) {
        this.handleFenceChar(ch, emitted);
      } else if (this.lineMode === 'plain') {
        this.handlePlainChar(ch, emitted);
      } else {
        this.handleUndeterminedChar(ch, emitted);
      }
    }
    return emitted;
  }

  flush(): string[] {
    const emitted: string[] = [];

    // Finish a trailing, not-yet-newline-terminated line first — it may
    // itself open a fence (e.g. a reply that ends mid-fence-opener), which
    // the fenceOpen check right after must then see and close.
    if (!this.fenceOpen && this.lineMode === 'undetermined' && this.lineBuffer.trim() !== '') {
      const line = this.lineBuffer;
      this.lineBuffer = '';
      this.completeUndeterminedLine(line, emitted);
    }

    if (this.fenceOpen) {
      this.fenceOpen = false;
      emitted.push('Code block omitted.');
    }

    this.lineBuffer = '';
    this.lineMode = 'undetermined';
    this.finalizeParagraph(emitted);
    return emitted;
  }

  private handleFenceChar(ch: string, emitted: string[]): void {
    if (ch !== '\n') {
      this.lineBuffer += ch;
      return;
    }
    const line = this.lineBuffer;
    this.lineBuffer = '';
    if (line.startsWith(this.fenceMarker)) {
      this.fenceOpen = false;
      emitted.push('Code block omitted.');
    }
  }

  private handlePlainChar(ch: string, emitted: string[]): void {
    this.plainBuffer += ch;
    this.drainPlain(emitted);
    if (ch === '\n') {
      this.lineMode = 'undetermined';
      this.lineBuffer = '';
    }
  }

  private handleUndeterminedChar(ch: string, emitted: string[]): void {
    if (ch === '\n') {
      const line = this.lineBuffer;
      this.lineBuffer = '';
      if (line.trim() === '') {
        this.finalizeParagraph(emitted);
      } else {
        this.completeUndeterminedLine(line, emitted);
      }
      return;
    }

    const candidate = this.lineBuffer + ch;
    if (isBlockCandidate(candidate)) {
      this.lineBuffer = candidate;
      return;
    }

    // This line turned out to be plain text, not a block construct — which
    // means it's a non-table-row line, so any table in progress ends here.
    this.resolveTableState(emitted);
    this.lineBuffer = '';
    this.lineMode = 'plain';
    this.plainBuffer += candidate;
    this.drainPlain(emitted);
  }

  /** A line whose classification is settled (matched a block pattern, or ran out at flush). */
  private completeUndeterminedLine(line: string, emitted: string[]): void {
    if (line.startsWith('|')) {
      this.handleTableLine(line, emitted);
      return;
    }

    // A non-table-row line always ends any table in progress.
    this.resolveTableState(emitted);

    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      this.forceDrainPlain(emitted);
      this.fenceOpen = true;
      this.fenceMarker = fenceMatch[1];
      return;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      this.forceDrainPlain(emitted);
      const text = terminate(inline(heading[1]));
      if (text) emitted.push(text);
      return;
    }

    const blockquote = line.match(BLOCKQUOTE_RE);
    if (blockquote) {
      this.forceDrainPlain(emitted);
      const text = inline(blockquote[1]).trim();
      if (text) emitted.push(text);
      return;
    }

    const ordered = line.match(ORDERED_ITEM_RE);
    if (ordered) {
      this.forceDrainPlain(emitted);
      const text = terminate(inline(ordered[1]));
      if (text) emitted.push(text);
      return;
    }

    const bullet = line.match(BULLET_ITEM_RE);
    if (bullet) {
      this.forceDrainPlain(emitted);
      const text = terminate(inline(bullet[1]));
      if (text) emitted.push(text);
      return;
    }

    // Candidacy held but nothing actually matched (e.g. a lone "#" or an
    // incomplete list marker cut off by flush()) — treat as plain text.
    this.appendPlain(line, emitted);
  }

  private handleTableLine(line: string, emitted: string[]): void {
    if (this.tableState === 'none') {
      this.forceDrainPlain(emitted);
      this.tableState = 'pendingHeader';
      this.pendingHeaderLine = line;
      return;
    }

    if (this.tableState === 'pendingHeader') {
      if (isTableSeparator(line)) {
        this.tableState = 'inTable';
        this.tableRowCount = 0;
        this.pendingHeaderLine = '';
        return;
      }
      // The held line wasn't followed by a valid separator, so it was never
      // a real header — treat it as plain text (with the line break it
      // originally ended in, so it doesn't glue onto whatever follows), then
      // re-evaluate the current line fresh (it may itself start a new table).
      const heldLine = this.pendingHeaderLine;
      this.tableState = 'none';
      this.pendingHeaderLine = '';
      this.appendPlain(`${heldLine}\n`, emitted);
      this.completeUndeterminedLine(line, emitted);
      return;
    }

    // inTable: another data row. Only the count is needed for the summary.
    this.tableRowCount++;
  }

  /** Resolves any table in progress (emits its summary, or reclaims a false-positive header). */
  private resolveTableState(emitted: string[]): void {
    if (this.tableState === 'inTable') {
      const n = this.tableRowCount;
      emitted.push(`Table with ${n} row${n === 1 ? '' : 's'} omitted.`);
    } else if (this.tableState === 'pendingHeader') {
      this.appendPlain(`${this.pendingHeaderLine}\n`, emitted);
    }
    this.tableState = 'none';
    this.pendingHeaderLine = '';
    this.tableRowCount = 0;
  }

  /** Resolves table state and force-emits whatever plain text remains — a paragraph boundary. */
  private finalizeParagraph(emitted: string[]): void {
    this.resolveTableState(emitted);
    this.forceDrainPlain(emitted);
  }

  private appendPlain(text: string, emitted: string[]): void {
    if (text === '') return;
    this.plainBuffer += text;
    this.drainPlain(emitted);
  }

  private drainPlain(emitted: string[]): void {
    for (;;) {
      const splitIndex = findSplit(this.plainBuffer, this.maxChars);
      if (splitIndex === null) break;
      const raw = this.plainBuffer.slice(0, splitIndex);
      this.plainBuffer = this.plainBuffer.slice(splitIndex).replace(/^\s+/, '');
      const sentence = speakable(raw);
      if (sentence) emitted.push(sentence);
    }
  }

  private forceDrainPlain(emitted: string[]): void {
    this.drainPlain(emitted);
    const rest = this.plainBuffer;
    this.plainBuffer = '';
    const sentence = speakable(rest);
    if (sentence) emitted.push(sentence);
  }
}
