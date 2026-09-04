import Foundation

/// A single block-level unit produced by `segmentMarkdown(_:)`.
///
/// Mirrors the block set Mission Control's markdown pipeline (react-markdown
/// + remark-gfm) parses assistant output into — design doc appendix §1 is
/// binding for the treatments each case gets when rendered. Inline
/// formatting (bold/italic/inline-code/links) is intentionally NOT resolved
/// here: each block's raw text is handed to `AttributedString(markdown:)` by
/// `MarkdownTextView` for inline parsing, so this type stays a plain,
/// dependency-free value.
///
/// `bullets`/`ordered` carry one item per line. Nested bullets (one level,
/// via leading-indent detection — see `segmentMarkdown`) are encoded as a
/// two-space prefix on the item string; ordered lists don't nest.
enum MarkdownBlock: Equatable, Sendable {
  case paragraph(String)
  case heading(level: Int, text: String)
  case bullets([String])
  case ordered([String])
  case fencedCode(language: String?, code: String)
  case blockquote(String)
  case horizontalRule
}

/// Splits raw assistant markdown text into block-level segments via a
/// single-pass, line-based scan.
///
/// Recognizes: ``` fenced code (with optional language tag), ATX headings
/// `#`–`####`, `- `/`* ` bullets (one nesting level via leading-indent),
/// `1. ` ordered lists, `> ` blockquotes, `---`/`***` horizontal rules, and
/// blank-line-delimited paragraphs. Everything else falls through to the
/// current paragraph.
///
/// Streaming-safe: an unclosed ``` fence at end-of-input still yields a
/// `.fencedCode` block (rather than being swallowed into a paragraph), so a
/// message mid-stream still renders sanely before the closing fence arrives.
///
/// Line endings are normalized to `\n` up front (CRLF, then lone CR) —
/// `CharacterSet.whitespaces` used throughout this scan does NOT include
/// `\r`, so unnormalized CRLF input would leave a trailing `\r` on fence
/// language tags, heading text, and would break hr/bullet/ordered detection
/// (e.g. `"---\r\n"` would otherwise segment as a paragraph, not an hr).
func segmentMarkdown(_ text: String) -> [MarkdownBlock] {
  let normalized = text
    .replacingOccurrences(of: "\r\n", with: "\n")
    .replacingOccurrences(of: "\r", with: "\n")
  let lines = normalized.components(separatedBy: "\n")
  var blocks: [MarkdownBlock] = []
  var paragraphLines: [String] = []
  var index = 0

  func flushParagraph() {
    guard !paragraphLines.isEmpty else { return }
    blocks.append(.paragraph(paragraphLines.joined(separator: "\n")))
    paragraphLines = []
  }

  while index < lines.count {
    let line = lines[index]
    let trimmed = line.trimmingCharacters(in: .whitespaces)

    if isFenceLine(line) {
      flushParagraph()
      let language = fenceLanguage(of: line)
      var codeLines: [String] = []
      index += 1
      while index < lines.count, !isFenceLine(lines[index]) {
        codeLines.append(lines[index])
        index += 1
      }
      if index < lines.count {
        // Consume the closing fence.
        index += 1
      }
      blocks.append(.fencedCode(language: language, code: codeLines.joined(separator: "\n")))
      continue
    }

    if trimmed.isEmpty {
      flushParagraph()
      index += 1
      continue
    }

    if let heading = parseHeading(line) {
      flushParagraph()
      blocks.append(heading)
      index += 1
      continue
    }

    if isHorizontalRule(trimmed) {
      flushParagraph()
      blocks.append(.horizontalRule)
      index += 1
      continue
    }

    if trimmed.hasPrefix(">") {
      flushParagraph()
      var quoteLines: [String] = []
      while index < lines.count {
        let quoteTrimmed = lines[index].trimmingCharacters(in: .whitespaces)
        guard quoteTrimmed.hasPrefix(">") else { break }
        var content = quoteTrimmed.dropFirst()
        if content.hasPrefix(" ") { content = content.dropFirst() }
        quoteLines.append(String(content))
        index += 1
      }
      blocks.append(.blockquote(quoteLines.joined(separator: "\n")))
      continue
    }

    if isBulletLine(line) {
      flushParagraph()
      var items: [String] = []
      while index < lines.count, isBulletLine(lines[index]) {
        items.append(bulletItemText(lines[index]))
        index += 1
      }
      blocks.append(.bullets(items))
      continue
    }

    if isOrderedLine(line) {
      flushParagraph()
      var items: [String] = []
      while index < lines.count, isOrderedLine(lines[index]) {
        items.append(orderedItemText(lines[index]))
        index += 1
      }
      blocks.append(.ordered(items))
      continue
    }

    paragraphLines.append(line)
    index += 1
  }

  flushParagraph()
  return blocks
}

// MARK: - Fenced code

private func isFenceLine(_ line: String) -> Bool {
  line.trimmingCharacters(in: .whitespaces).hasPrefix("```")
}

private func fenceLanguage(of line: String) -> String? {
  let trimmed = line.trimmingCharacters(in: .whitespaces)
  let rest = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
  return rest.isEmpty ? nil : rest
}

// MARK: - Headings

/// Recognizes ATX headings of level 1–4 only (design doc scope). A run of
/// 5+ `#` is not treated as a heading and falls through to a paragraph.
private func parseHeading(_ line: String) -> MarkdownBlock? {
  var level = 0
  var rest = Substring(line)
  while rest.first == "#", level < 4 {
    level += 1
    rest = rest.dropFirst()
  }
  guard level > 0 else { return nil }
  if rest.first == "#" { return nil }
  guard rest.isEmpty || rest.first == " " else { return nil }
  let text = rest.trimmingCharacters(in: .whitespaces)
  return .heading(level: level, text: text)
}

// MARK: - Horizontal rule

private func isHorizontalRule(_ trimmed: String) -> Bool {
  let compact = trimmed.replacingOccurrences(of: " ", with: "")
  guard compact.count >= 3, let first = compact.first else { return false }
  guard first == "-" || first == "*" || first == "_" else { return false }
  return compact.allSatisfy { $0 == first }
}

// MARK: - Bullets

/// One nesting level: any leading indent (1+ spaces) is normalized to a
/// single two-space marker prefix on the returned item text, regardless of
/// how deeply the source indented it.
private func isBulletLine(_ line: String) -> Bool {
  let indent = line.prefix(while: { $0 == " " }).count
  let rest = line.dropFirst(indent)
  return rest.hasPrefix("- ") || rest.hasPrefix("* ")
}

private func bulletItemText(_ line: String) -> String {
  let indent = line.prefix(while: { $0 == " " }).count
  let rest = line.dropFirst(indent + 2)
  return indent > 0 ? "  " + rest : String(rest)
}

// MARK: - Ordered lists

private func orderedPrefixLength(_ trimmed: Substring) -> Int? {
  var index = trimmed.startIndex
  var digitCount = 0
  while index < trimmed.endIndex, trimmed[index].isNumber {
    index = trimmed.index(after: index)
    digitCount += 1
  }
  guard digitCount > 0, index < trimmed.endIndex, trimmed[index] == "." else { return nil }
  index = trimmed.index(after: index)
  guard index < trimmed.endIndex, trimmed[index] == " " else { return nil }
  index = trimmed.index(after: index)
  return trimmed.distance(from: trimmed.startIndex, to: index)
}

private func isOrderedLine(_ line: String) -> Bool {
  orderedPrefixLength(Substring(line.trimmingCharacters(in: .whitespaces))) != nil
}

private func orderedItemText(_ line: String) -> String {
  let trimmed = Substring(line.trimmingCharacters(in: .whitespaces))
  guard let length = orderedPrefixLength(trimmed) else { return String(trimmed) }
  return String(trimmed.dropFirst(length))
}
