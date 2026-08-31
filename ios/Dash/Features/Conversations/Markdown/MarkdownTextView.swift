import SwiftUI

/// Inline-only markdown parsing options shared by every block's text: bold,
/// italic, inline code, and links resolve; block syntax (headings, lists,
/// fences) does not get re-interpreted, since `segmentMarkdown` already
/// extracted it. `.inlineOnlyPreservingWhitespace` keeps literal line breaks
/// inside a paragraph instead of collapsing them, matching MC's
/// `whitespace-pre-wrap`-adjacent rendering.
let markdownInlineParsingOptions = AttributedString.MarkdownParsingOptions(
  allowsExtendedAttributes: true,
  interpretedSyntax: .inlineOnlyPreservingWhitespace,
  failurePolicy: .throwError
)

/// Inline `code` span color — MC's `text-orange-300` token (design doc
/// appendix §1).
let markdownInlineCodeColor = Color(red: 0xfd / 255, green: 0xba / 255, blue: 0x74 / 255)

/// Parses `raw` as inline markdown and re-styles inline-code runs orange +
/// monospaced to match MC. Falls back to a plain, unstyled `AttributedString`
/// if parsing throws (e.g. malformed input mid-stream) — the MC screenshot
/// regression this guards against is literal `**asterisks**` leaking into
/// the rendered text instead of producing a bold run.
///
/// Plain function (no view/state) so it's directly unit-testable.
func attributedInlineMarkdown(_ raw: String) -> AttributedString {
  guard var attributed = try? AttributedString(markdown: raw, options: markdownInlineParsingOptions)
  else {
    return AttributedString(raw)
  }
  for run in attributed.runs where run.inlinePresentationIntent?.contains(.code) == true {
    attributed[run.range].foregroundColor = markdownInlineCodeColor
    attributed[run.range].font = .system(.caption, design: .monospaced)
  }
  return attributed
}

/// Renders a block-segmented markdown document (see `segmentMarkdown`) with
/// MC-parity typography and spacing (design doc appendix §1).
struct MarkdownTextView: View {
  let text: String

  var body: some View {
    let blocks = segmentMarkdown(text)
    VStack(alignment: .leading, spacing: 6) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        MarkdownBlockView(block: block)
      }
    }
  }
}

private struct MarkdownBlockView: View {
  let block: MarkdownBlock

  var body: some View {
    switch block {
    case .paragraph(let text):
      Text(attributedInlineMarkdown(text))
        .textSelection(.enabled)

    case .heading(let level, let text):
      Text(attributedInlineMarkdown(text))
        .font(headingFont(level))
        .textSelection(.enabled)

    case .bullets(let items):
      VStack(alignment: .leading, spacing: 4) {
        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
          MarkdownBulletRow(item: item)
        }
      }

    case .ordered(let items):
      VStack(alignment: .leading, spacing: 4) {
        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
          MarkdownOrderedRow(number: index + 1, text: item)
        }
      }

    case .fencedCode(let language, let code):
      CodeBlockView(code: code, language: language)

    case .blockquote(let text):
      MarkdownBlockquoteView(text: text)

    case .horizontalRule:
      Divider()
    }
  }

  private func headingFont(_ level: Int) -> Font {
    switch level {
    case 1: .title2.bold()
    case 2: .title3.bold()
    case 3: .headline
    default: .subheadline.bold()
    }
  }
}

/// One bullet row. Nested items (one level, encoded by `segmentMarkdown` as
/// a two-space prefix) get an extra leading indent.
private struct MarkdownBulletRow: View {
  let item: String

  var body: some View {
    let isNested = item.hasPrefix("  ")
    let displayText = isNested ? String(item.dropFirst(2)) : item
    HStack(alignment: .top, spacing: 0) {
      Text("•  ")
      Text(attributedInlineMarkdown(displayText))
    }
    .padding(.leading, isNested ? 16 : 0)
    .textSelection(.enabled)
  }
}

private struct MarkdownOrderedRow: View {
  let number: Int
  let text: String

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      Text("\(number).  ")
      Text(attributedInlineMarkdown(text))
    }
    .textSelection(.enabled)
  }
}

/// Blockquote: 2pt leading bar overlay, muted text (design doc appendix §1).
private struct MarkdownBlockquoteView: View {
  let text: String

  var body: some View {
    Text(attributedInlineMarkdown(text))
      .foregroundStyle(.secondary)
      .padding(.leading, 10)
      .overlay(alignment: .leading) {
        Rectangle()
          .fill(Color.secondary)
          .frame(width: 2)
      }
      .textSelection(.enabled)
  }
}
