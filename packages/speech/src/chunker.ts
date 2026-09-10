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

/** See rule 1 in {@link findSplit}. */
function isSuppressedBoundary(text: string, punctuationIndex: number): boolean {
  let tokenStart = punctuationIndex;
  while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1])) tokenStart--;
  const precedingToken = text.slice(tokenStart, punctuationIndex);

  if (/^[A-Za-z](\.[A-Za-z])*$/.test(precedingToken)) return true;

  if (/^\d+$/.test(precedingToken)) {
    const afterWhitespace = text.slice(punctuationIndex + 1).replace(/^\s+/, '');
    if (/^\d/.test(afterWhitespace)) return true;
  }

  return false;
}

export interface SentenceChunkerOptions {
  /** Maximum sentence length before a forced split at the last whitespace. Default 280. */
  maxChars?: number;
}

/**
 * Turns a streamed markdown reply into speakable sentences, one at a time,
 * for per-sentence text-to-speech.
 *
 * Raw markdown is buffered line by line. A fenced code block (opened by a
 * line starting with three backticks or tildes) holds its paragraph — nothing
 * is emitted from it — until the matching fence closes or `flush()` is
 * called. Once a paragraph is complete (a blank line is reached with the
 * fence not open, or `flush()` forces completion), `speakable` is applied to
 * it and the result is appended to a pending buffer, which is then scanned
 * for sentence boundaries (see `findSplit`). A completed paragraph always
 * drains its pending buffer fully — even without trailing punctuation —
 * since the blank line that ended it is itself an emit trigger.
 */
export class SentenceChunker {
  private readonly maxChars: number;
  private lineBuffer = '';
  private paragraphLines: string[] = [];
  private fenceOpen = false;
  private fenceMarker = '';
  private pending = '';

  constructor(options: SentenceChunkerOptions = {}) {
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  }

  push(delta: string): string[] {
    const emitted: string[] = [];
    for (const ch of delta) {
      if (ch === '\n') {
        const line = this.lineBuffer;
        this.lineBuffer = '';
        this.completeLine(line, emitted);
      } else {
        this.lineBuffer += ch;
      }
    }
    return emitted;
  }

  flush(): string[] {
    const emitted: string[] = [];

    if (this.lineBuffer !== '') {
      const line = this.lineBuffer;
      this.lineBuffer = '';
      if (line.trim() !== '' || this.fenceOpen) {
        this.paragraphLines.push(line);
      }
    }

    this.fenceOpen = false;

    if (this.paragraphLines.length > 0) {
      this.completeParagraph(emitted);
    } else {
      const rest = this.pending.trim();
      if (rest) emitted.push(rest);
      this.pending = '';
    }

    return emitted;
  }

  private completeLine(line: string, emitted: string[]): void {
    const fenceMatch = line.match(FENCE_RE);

    if (this.fenceOpen) {
      this.paragraphLines.push(line);
      if (fenceMatch && line.startsWith(this.fenceMarker)) this.fenceOpen = false;
      return;
    }

    if (fenceMatch) {
      this.fenceOpen = true;
      this.fenceMarker = fenceMatch[1];
      this.paragraphLines.push(line);
      return;
    }

    if (line.trim() === '') {
      if (this.paragraphLines.length > 0) this.completeParagraph(emitted);
      return;
    }

    this.paragraphLines.push(line);
  }

  private completeParagraph(emitted: string[]): void {
    const raw = this.paragraphLines.join('\n');
    this.paragraphLines = [];

    const text = speakable(raw);
    if (text) this.pending = this.pending ? `${this.pending} ${text}` : text;

    this.drainSentences(emitted);

    const rest = this.pending.trim();
    if (rest) emitted.push(rest);
    this.pending = '';
  }

  private drainSentences(emitted: string[]): void {
    for (;;) {
      const splitIndex = findSplit(this.pending, this.maxChars);
      if (splitIndex === null) break;
      const sentence = this.pending.slice(0, splitIndex).trim();
      if (sentence) emitted.push(sentence);
      this.pending = this.pending.slice(splitIndex).trim();
    }
  }
}
