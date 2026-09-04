import Foundation

/// A single block-level unit produced by `segmentMarkdown(_:)`.
///
/// Mirrors the block set the web renderer (react-markdown + remark-gfm)
/// parses assistant output into. Inline formatting (bold/italic/inline
/// code/links/strikethrough) is intentionally NOT resolved here: each
/// block's raw text is handed to `AttributedString(markdown:)` by
/// `MarkdownTextView` for inline parsing, so this type stays a plain,
/// dependency-free value.
///
/// 2026-09-04 (iOS markdown parity): lists became a real tree
/// (`MarkdownList` — nesting to any depth, ordered/bullet mixing, start
/// numbers, task-item state, fenced code as a child block) and GFM pipe
/// tables joined the set. Headings go to level 6, as in GFM.
enum MarkdownBlock: Equatable, Sendable {
  case paragraph(String)
  case heading(level: Int, text: String)
  case list(MarkdownList)
  case fencedCode(language: String?, code: String)
  case blockquote(String)
  case horizontalRule
  case table(MarkdownTable)
}

struct MarkdownListItem: Equatable, Sendable {
  var text: String
  /// `nil` for a plain item; `true`/`false` for a `- [x]` / `- [ ]` task item.
  var checked: Bool? = nil
  /// Nested lists and fenced code indented under this item, in source order.
  var children: [MarkdownBlock] = []
}

struct MarkdownList: Equatable, Sendable {
  var ordered: Bool
  /// First item's number for ordered lists (`3.` starts at 3); 1 for bullets.
  var start: Int = 1
  var items: [MarkdownListItem]
}

enum MarkdownTableAlignment: Equatable, Sendable {
  case none, left, center, right
}

struct MarkdownTable: Equatable, Sendable {
  var header: [String]
  var alignments: [MarkdownTableAlignment]
  var rows: [[String]]
}

/// Splits raw assistant markdown text into block-level segments via a
/// single-pass, line-based scan.
///
/// Recognizes: ``` fenced code (with optional language tag), ATX headings
/// `#`–`######`, `-`/`*`/`+` bullets and `1.`/`1)` ordered items nested by
/// indentation (with `[ ]`/`[x]` task state, indented continuation lines,
/// blank lines between items, and fenced code under an item), GFM pipe
/// tables (a header row followed by a `---`/`:---:` delimiter row), `> `
/// blockquotes, `---`/`***`/`___` horizontal rules, and
/// blank-line-delimited paragraphs. Everything else falls through to the
/// current paragraph.
///
/// Streaming-safe: an unclosed ``` fence at end-of-input still yields a
/// `.fencedCode` block, and a table header whose delimiter row hasn't
/// arrived yet stays a paragraph until it does.
///
/// Line endings are normalized to `\n` up front (CRLF, then lone CR) —
/// `CharacterSet.whitespaces` used throughout this scan does NOT include
/// `\r`, so unnormalized CRLF input would leave a trailing `\r` on fence
/// language tags, heading text, and would break hr/list detection.
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
      let (block, next) = parseFence(lines, from: index, contentIndent: 0)
      blocks.append(block)
      index = next
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

    if let (table, next) = parseTable(lines, from: index) {
      flushParagraph()
      blocks.append(.table(table))
      index = next
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

    if listMarker(line) != nil {
      flushParagraph()
      let (list, next) = parseList(lines, from: index)
      blocks.append(.list(list))
      index = next
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

/// Parses a fence starting at `from`; `contentIndent` columns of leading
/// whitespace are stripped from each code line (a fence nested under a
/// list item is indented with it). Returns the block and the index after
/// the closing fence (or end-of-input for an unclosed one).
private func parseFence(_ lines: [String], from start: Int, contentIndent: Int) -> (MarkdownBlock, Int) {
  let language = fenceLanguage(of: lines[start])
  var codeLines: [String] = []
  var index = start + 1
  while index < lines.count, !isFenceLine(lines[index]) {
    codeLines.append(String(dropIndent(lines[index], upTo: contentIndent)))
    index += 1
  }
  if index < lines.count { index += 1 }
  return (.fencedCode(language: language, code: codeLines.joined(separator: "\n")), index)
}

private func dropIndent(_ line: String, upTo columns: Int) -> Substring {
  var dropped = 0
  var sub = Substring(line)
  while dropped < columns, sub.first == " " {
    sub = sub.dropFirst()
    dropped += 1
  }
  return sub
}

// MARK: - Headings

/// ATX headings of level 1–6 (GFM). A run of 7+ `#` falls through to a
/// paragraph.
private func parseHeading(_ line: String) -> MarkdownBlock? {
  var level = 0
  var rest = Substring(line)
  while rest.first == "#", level < 6 {
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

// MARK: - Lists

private struct ListMarker {
  let indent: Int
  let ordered: Bool
  let number: Int
  /// Column where the item's text starts (marker + following space).
  let contentIndent: Int
  let checked: Bool?
  let text: String
}

/// Recognizes `-`/`*`/`+` and `N.`/`N)` markers at any indent, plus an
/// optional `[ ]`/`[x]` task box right after the marker.
private func listMarker(_ line: String) -> ListMarker? {
  let indent = line.prefix(while: { $0 == " " }).count
  let rest = Substring(line.dropFirst(indent))
  guard let first = rest.first else { return nil }
  var ordered = false
  var number = 1
  var markerLength = 0
  if first == "-" || first == "*" || first == "+" {
    markerLength = 1
  } else if first.isNumber {
    var digits = 0
    var idx = rest.startIndex
    while idx < rest.endIndex, rest[idx].isNumber {
      idx = rest.index(after: idx)
      digits += 1
    }
    guard digits <= 9, idx < rest.endIndex, rest[idx] == "." || rest[idx] == ")" else { return nil }
    ordered = true
    number = Int(rest[rest.startIndex..<idx]) ?? 1
    markerLength = digits + 1
  } else {
    return nil
  }
  let afterMarker = rest.dropFirst(markerLength)
  guard afterMarker.hasPrefix(" ") else { return nil }
  var content = afterMarker.drop(while: { $0 == " " })
  let contentIndent = indent + markerLength + (afterMarker.count - content.count)
  var checked: Bool? = nil
  if content.hasPrefix("[ ] ") || content == "[ ]" {
    checked = false
    content = content.dropFirst(3).drop(while: { $0 == " " })
  } else if content.hasPrefix("[x] ") || content.hasPrefix("[X] ") || content == "[x]" || content == "[X]" {
    checked = true
    content = content.dropFirst(3).drop(while: { $0 == " " })
  }
  return ListMarker(
    indent: indent,
    ordered: ordered,
    number: number,
    contentIndent: contentIndent,
    checked: checked,
    text: String(content)
  )
}

/// Parses one (possibly nested) list starting at `from`. A stack of frames
/// tracks the indent each open list started at; a marker indented past the
/// current item's text starts a child list, a marker at or before an
/// ancestor's indent closes back to it. Indented non-marker lines continue
/// the current item's text; an indented ``` fence becomes a child block.
/// Blank lines are skipped when what follows still belongs to the list.
private func parseList(_ lines: [String], from start: Int) -> (MarkdownList, Int) {
  struct Frame {
    var indent: Int
    var list: MarkdownList
    var contentIndent: Int
  }
  var frames: [Frame] = []
  var index = start

  func closeTop() {
    let child = frames.removeLast()
    if frames.isEmpty {
      frames.append(child)
      return
    }
    frames[frames.count - 1].list.items[frames[frames.count - 1].list.items.count - 1]
      .children.append(.list(child.list))
  }

  func appendToCurrentItemText(_ text: String) {
    guard frames.isEmpty == false else { return }
    let last = frames.count - 1
    let item = frames[last].list.items.count - 1
    frames[last].list.items[item].text += "\n" + text
  }

  while index < lines.count {
    let line = lines[index]
    let trimmed = line.trimmingCharacters(in: .whitespaces)

    if trimmed.isEmpty {
      // Look past blank lines: the list continues only if the next
      // non-blank line is a marker or is indented under an item.
      var probe = index + 1
      while probe < lines.count, lines[probe].trimmingCharacters(in: .whitespaces).isEmpty { probe += 1 }
      guard probe < lines.count else { break }
      let nextIndent = lines[probe].prefix(while: { $0 == " " }).count
      if listMarker(lines[probe]) != nil || nextIndent >= 2 {
        index = probe
        continue
      }
      break
    }

    if let marker = listMarker(line) {
      // Fold frames deeper than this marker's indent.
      while frames.count > 1, frames[frames.count - 1].indent > marker.indent {
        closeTop()
      }
      // A marker of the other kind at this level starts a NEW list
      // (CommonMark): `- a` then `1. b` are two lists, not one.
      if let top = frames.last, marker.indent <= top.indent, marker.ordered != top.list.ordered {
        break
      }
      if frames.isEmpty {
        frames.append(
          Frame(
            indent: marker.indent,
            list: MarkdownList(ordered: marker.ordered, start: marker.number, items: []),
            contentIndent: marker.contentIndent
          )
        )
      } else if marker.indent > frames[frames.count - 1].indent
        && frames[frames.count - 1].list.items.isEmpty == false
      {
        // Nested under the current item.
        frames.append(
          Frame(
            indent: marker.indent,
            list: MarkdownList(ordered: marker.ordered, start: marker.number, items: []),
            contentIndent: marker.contentIndent
          )
        )
      }
      frames[frames.count - 1].contentIndent = marker.contentIndent
      frames[frames.count - 1].list.items.append(
        MarkdownListItem(text: marker.text, checked: marker.checked)
      )
      index += 1
      continue
    }

    let indent = line.prefix(while: { $0 == " " }).count
    if isFenceLine(line), indent >= 2, frames.isEmpty == false {
      let (block, next) = parseFence(lines, from: index, contentIndent: indent)
      let last = frames.count - 1
      frames[last].list.items[frames[last].list.items.count - 1].children.append(block)
      index = next
      continue
    }

    if indent >= 2 || index > start {
      // Continuation of the current item (indented, or a lazy line right
      // after an item with no blank in between).
      let previousBlank = index > 0 && lines[index - 1].trimmingCharacters(in: .whitespaces).isEmpty
      if indent >= 2 || previousBlank == false {
        appendToCurrentItemText(trimmed)
        index += 1
        continue
      }
    }
    break
  }

  while frames.count > 1 { closeTop() }
  return (frames[0].list, index)
}

// MARK: - Tables

private func splitTableRow(_ line: String) -> [String] {
  var cells: [String] = []
  var current = ""
  var escaped = false
  var trimmed = Substring(line.trimmingCharacters(in: .whitespaces))
  if trimmed.hasPrefix("|") { trimmed = trimmed.dropFirst() }
  if trimmed.hasSuffix("|"), !trimmed.hasSuffix("\\|") { trimmed = trimmed.dropLast() }
  for character in trimmed {
    if escaped {
      current.append(character == "|" ? "|" : "\\\(character)")
      escaped = false
    } else if character == "\\" {
      escaped = true
    } else if character == "|" {
      cells.append(current.trimmingCharacters(in: .whitespaces))
      current = ""
    } else {
      current.append(character)
    }
  }
  if escaped { current.append("\\") }
  cells.append(current.trimmingCharacters(in: .whitespaces))
  return cells
}

private func delimiterAlignments(_ line: String) -> [MarkdownTableAlignment]? {
  let cells = splitTableRow(line)
  guard cells.isEmpty == false else { return nil }
  var alignments: [MarkdownTableAlignment] = []
  for cell in cells {
    guard cell.isEmpty == false else { return nil }
    let leading = cell.hasPrefix(":")
    let trailing = cell.hasSuffix(":")
    let dashes = cell.dropFirst(leading ? 1 : 0).dropLast(trailing ? 1 : 0)
    guard dashes.isEmpty == false, dashes.allSatisfy({ $0 == "-" }) else { return nil }
    switch (leading, trailing) {
    case (true, true): alignments.append(.center)
    case (true, false): alignments.append(.left)
    case (false, true): alignments.append(.right)
    case (false, false): alignments.append(.none)
    }
  }
  return alignments
}

/// A GFM table needs a header row containing `|` immediately followed by a
/// delimiter row; body rows run until a blank line or a line without `|`.
private func parseTable(_ lines: [String], from start: Int) -> (MarkdownTable, Int)? {
  guard lines[start].contains("|"), start + 1 < lines.count,
    let alignments = delimiterAlignments(lines[start + 1])
  else { return nil }
  let header = splitTableRow(lines[start])
  guard header.count == alignments.count else { return nil }
  var rows: [[String]] = []
  var index = start + 2
  while index < lines.count {
    let line = lines[index]
    guard line.contains("|"), line.trimmingCharacters(in: .whitespaces).isEmpty == false else { break }
    var cells = splitTableRow(line)
    if cells.count < header.count {
      cells.append(contentsOf: Array(repeating: "", count: header.count - cells.count))
    } else if cells.count > header.count {
      cells = Array(cells.prefix(header.count))
    }
    rows.append(cells)
    index += 1
  }
  return (MarkdownTable(header: header, alignments: alignments, rows: rows), index)
}
