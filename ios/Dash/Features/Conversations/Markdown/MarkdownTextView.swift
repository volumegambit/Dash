import SwiftUI

/// Inline-only markdown parsing options shared by every block's text: bold,
/// italic, inline code, strikethrough, and links resolve; block syntax
/// (headings, lists, fences) does not get re-interpreted, since
/// `segmentMarkdown` already extracted it. `.inlineOnlyPreservingWhitespace`
/// keeps literal line breaks inside a paragraph instead of collapsing them,
/// matching MC's `whitespace-pre-wrap`-adjacent rendering.
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
/// Bare URLs (`https://…` with no `[label](…)` around them) become links
/// too — remark-gfm autolinks them on web, and agents paste URLs bare far
/// more often than they wrap them. Runs that already carry a link (explicit
/// markdown links) are left alone.
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
  autolinkBareURLs(in: &attributed)
  return attributed
}

private let bareURLDetector: NSDataDetector? = try? NSDataDetector(
  types: NSTextCheckingResult.CheckingType.link.rawValue
)

private func autolinkBareURLs(in attributed: inout AttributedString) {
  guard let detector = bareURLDetector else { return }
  let plain = String(attributed.characters)
  let matches = detector.matches(in: plain, range: NSRange(plain.startIndex..., in: plain))
  for match in matches {
    guard let url = match.url, let range = Range(match.range, in: plain) else { continue }
    guard url.scheme == "http" || url.scheme == "https" else { continue }
    let lower = attributed.characters.index(
      attributed.startIndex,
      offsetBy: plain.distance(from: plain.startIndex, to: range.lowerBound)
    )
    let upper = attributed.characters.index(
      attributed.startIndex,
      offsetBy: plain.distance(from: plain.startIndex, to: range.upperBound)
    )
    let attributedRange = lower..<upper
    // Explicit `[label](url)` links already carry `.link`; don't clobber them.
    let alreadyLinked = attributed[attributedRange].runs.contains { $0.link != nil }
    guard alreadyLinked == false else { continue }
    // Inline code spans are literal text, not links.
    let inCode = attributed[attributedRange].runs.contains {
      $0.inlinePresentationIntent?.contains(.code) == true
    }
    guard inCode == false else { continue }
    attributed[attributedRange].link = url
  }
}

/// Builds a VoiceOver-friendly plain-text accessibility label for markdown
/// content — the a11y counterpart to `MarkdownTextView`'s visual rendering.
///
/// Reading raw markdown source aloud is bad UX (VoiceOver says "star star
/// Ship it star star backtick now backtick" for `"**Ship it** \`now\`"`).
/// This instead segments `text` with `segmentMarkdown` (the same
/// segmentation `MarkdownTextView` renders from) and, per block, resolves
/// the block's text through `attributedInlineMarkdown` — which parses
/// `**bold**`, `` `code` ``, links, etc. into an `AttributedString` and
/// discards the syntax — then takes its plain `.characters`. Fenced code
/// blocks are the one exception: their content is literal code, not
/// markdown, so the raw code text is used as-is rather than being run
/// through markdown parsing. Horizontal rules carry no readable text and
/// are dropped. Each block contributes newline-separated lines, so
/// structure (paragraph breaks, list items — nested ones flattened in
/// order — and table rows, cells comma-joined) still reads as distinct
/// utterances rather than being smashed into one run-on sentence.
func markdownPlainTextAccessibilityLabel(for text: String) -> String {
  accessibilityLines(for: segmentMarkdown(text)).joined(separator: "\n")
}

private func accessibilityLines(for blocks: [MarkdownBlock]) -> [String] {
  blocks.flatMap { block -> [String] in
    switch block {
    case .paragraph(let blockText), .heading(_, let blockText), .blockquote(let blockText):
      return [String(attributedInlineMarkdown(blockText).characters)]
    case .list(let list):
      return list.items.flatMap { item -> [String] in
        var lines = [String(attributedInlineMarkdown(item.text).characters)]
        if let checked = item.checked {
          lines[0] = (checked ? "completed, " : "not completed, ") + lines[0]
        }
        return lines + accessibilityLines(for: item.children)
      }
    case .fencedCode(_, let code):
      return [code]
    case .horizontalRule:
      return []
    case .image(_, let alt):
      return [alt.map { "Image: \($0)" } ?? "Image"]
    case .table(let table):
      let header = table.header.map { String(attributedInlineMarkdown($0).characters) }
      let rows = table.rows.map { row in
        row.map { String(attributedInlineMarkdown($0).characters) }.joined(separator: ", ")
      }
      return [header.joined(separator: ", ")] + rows
    }
  }
}

/// Renders a block-segmented markdown document (see `segmentMarkdown`) with
/// MC-parity typography and spacing (design doc appendix §1).
struct MarkdownTextView: View {
  let text: String

  var body: some View {
    let blocks = segmentMarkdown(text)
    MarkdownBlocksView(blocks: blocks)
  }
}

/// Extra leading between wrapped lines of prose (chat UI polish
/// 2026-09-05). SwiftUI's default is the font's own tight leading, which is
/// tuned for labels; assistant replies are long-form body text read on a
/// phone, where set-solid lines are what makes a wall of text a wall.
///
/// Applied to prose only — paragraphs, blockquotes, list items. Code blocks
/// and tables keep the default, where line breaks are structural rather than
/// a consequence of wrapping and extra leading just spreads them out.
private let markdownProseLineSpacing: CGFloat = 3

/// Gap between blocks. Must stay clearly larger than
/// `markdownProseLineSpacing`: if the space between two paragraphs is not
/// visibly greater than the space between two wrapped lines, the paragraph
/// break stops reading as one.
private let markdownBlockSpacing: CGFloat = 10

/// A vertical run of blocks — the document body, or a list item's children.
private struct MarkdownBlocksView: View {
  let blocks: [MarkdownBlock]

  var body: some View {
    VStack(alignment: .leading, spacing: markdownBlockSpacing) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        MarkdownBlockView(block: block, depth: 0)
      }
    }
  }
}

private struct MarkdownBlockView: View {
  let block: MarkdownBlock
  let depth: Int

  var body: some View {
    switch block {
    case .paragraph(let text):
      Text(attributedInlineMarkdown(text))
        .lineSpacing(markdownProseLineSpacing)
        .textSelection(.enabled)

    case .heading(let level, let text):
      Text(attributedInlineMarkdown(text))
        .font(headingFont(level))
        .textSelection(.enabled)

    case .list(let list):
      MarkdownListView(list: list, depth: depth)

    case .fencedCode(let language, let code):
      CodeBlockView(code: code, language: language)

    case .blockquote(let text):
      MarkdownBlockquoteView(text: text)

    case .horizontalRule:
      Divider()

    case .table(let table):
      MarkdownTableView(table: table)

    case .image(let url, let alt):
      MarkdownImageView(url: url, alt: alt)
    }
  }

  private func headingFont(_ level: Int) -> Font {
    switch level {
    case 1: .title2.bold()
    case 2: .title3.bold()
    case 3: .headline
    case 4: .subheadline.bold()
    default: .footnote.bold()
    }
  }
}

/// One list (any depth). Each item is a marker column — bullet glyph by
/// depth, `N.` for ordered lists counting from the list's `start`, or a
/// non-interactive checkbox for task items — beside the item's text and,
/// under it, its child blocks (nested lists, fenced code) rendered
/// recursively one level deeper.
private struct MarkdownListView: View {
  let list: MarkdownList
  let depth: Int

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(Array(list.items.enumerated()), id: \.offset) { index, item in
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          marker(for: item, index: index)
            .frame(minWidth: list.ordered ? 22 : 14, alignment: .trailing)
          VStack(alignment: .leading, spacing: 4) {
            Text(attributedInlineMarkdown(item.text))
              .lineSpacing(markdownProseLineSpacing)
              .textSelection(.enabled)
            ForEach(Array(item.children.enumerated()), id: \.offset) { _, child in
              MarkdownBlockView(block: child, depth: depth + 1)
            }
          }
        }
      }
    }
    .padding(.leading, depth > 0 ? 4 : 0)
  }

  @ViewBuilder
  private func marker(for item: MarkdownListItem, index: Int) -> some View {
    if let checked = item.checked {
      Image(systemName: checked ? "checkmark.square.fill" : "square")
        .foregroundStyle(checked ? DashTheme.accent : Color.secondary)
        .accessibilityLabel(checked ? "Completed" : "Not completed")
    } else if list.ordered {
      Text("\(list.start + index).")
        .foregroundStyle(.secondary)
        .monospacedDigit()
    } else {
      Text(bulletGlyph)
        .foregroundStyle(.secondary)
    }
  }

  private var bulletGlyph: String {
    switch depth {
    case 0: "•"
    case 1: "◦"
    default: "▪"
    }
  }
}

/// GFM pipe table: a `Grid` with a bold header row, hairline divider, and
/// per-column alignment from the delimiter row, inside a horizontal
/// `ScrollView` so wide tables scroll instead of squeezing (the web wraps
/// `.md-table` in an overflow container the same way). Cells are inline
/// markdown, so `**bold**` and `` `code` `` work inside them.
private struct MarkdownTableView: View {
  let table: MarkdownTable

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      Grid(alignment: .topLeading, horizontalSpacing: 16, verticalSpacing: 6) {
        GridRow {
          ForEach(Array(table.header.enumerated()), id: \.offset) { column, cell in
            Text(attributedInlineMarkdown(cell))
              .font(.subheadline.weight(.semibold))
              .gridColumnAlignment(alignment(for: column))
          }
        }
        Divider().gridCellUnsizedAxes(.horizontal)
        ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
          GridRow {
            ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
              Text(attributedInlineMarkdown(cell))
                .font(.subheadline)
                .gridColumnAlignment(alignment(for: column))
            }
          }
        }
      }
      .padding(10)
      .background(
        Color.secondary.opacity(DashTheme.Opacity.fillSubtle),
        in: RoundedRectangle(cornerRadius: DashTheme.Radius.small)
      )
      .textSelection(.enabled)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      ([table.header.joined(separator: ", ")] + table.rows.map { $0.joined(separator: ", ") })
        .joined(separator: "\n")
    )
    .accessibilityIdentifier("chat.markdown.table")
  }

  private func alignment(for column: Int) -> HorizontalAlignment {
    guard column < table.alignments.count else { return .leading }
    switch table.alignments[column] {
    case .center: return .center
    case .right: return .trailing
    case .left, .none: return .leading
    }
  }
}

/// A standalone markdown image (`![alt](url)` or a bare image-extension
/// URL — see `MarkdownBlocks.parseStandaloneImage`). SwiftUI `Text` cannot
/// render a remote image inline, so this is a dedicated view.
///
/// While loading: a muted placeholder sized like a thumbnail. On success:
/// the image, capped to a readable height, rounded, and tappable to open
/// the same full-screen `ImageViewerView` (pinch/zoom/Share/Save) that
/// attached images use — so a generated image can be saved to Photos. On
/// failure (network, or a URL that turns out not to be an image): fall back
/// to a tappable link so nothing is lost, matching the pre-change behavior.
private struct MarkdownImageView: View {
  let url: URL
  let alt: String?

  @State private var loaded: UIImage?
  @State private var failed = false
  @State private var viewerImage: ViewerImage?

  /// Cap so a tall image doesn't dominate the scroll view; the full image
  /// is one tap away in the viewer.
  private let maxHeight: CGFloat = 320

  var body: some View {
    content
      .task(id: url) { await load() }
      .fullScreenCover(item: $viewerImage) { item in
        ImageViewerView(image: item.image) { viewerImage = nil }
      }
  }

  @ViewBuilder
  private var content: some View {
    if let loaded {
      Button {
        viewerImage = ViewerImage(id: 0, image: loaded)
      } label: {
        Image(uiImage: loaded)
          .resizable()
          .scaledToFit()
          .frame(maxWidth: .infinity, alignment: .leading)
          .frame(maxHeight: maxHeight)
          .clipShape(RoundedRectangle(cornerRadius: DashTheme.Radius.small))
      }
      .buttonStyle(.plain)
      .accessibilityLabel(alt.map { "Image: \($0)" } ?? "Image")
      .accessibilityIdentifier("chat.markdown.image")
    } else if failed {
      Link(destination: url) {
        Text(alt?.isEmpty == false ? alt! : url.absoluteString)
      }
      .accessibilityIdentifier("chat.markdown.imageLinkFallback")
    } else {
      RoundedRectangle(cornerRadius: DashTheme.Radius.small)
        .fill(Color.secondary.opacity(DashTheme.Opacity.fillSubtle))
        .frame(height: 160)
        .frame(maxWidth: .infinity)
        .overlay(ProgressView())
        .accessibilityLabel("Loading image")
        .accessibilityIdentifier("chat.markdown.imageLoading")
    }
  }

  private func load() async {
    // Re-entry on `url` change: reset so a recycled view doesn't flash the
    // previous image or a stale failure.
    loaded = nil
    failed = false
    do {
      let (data, response) = try await URLSession.shared.data(from: url)
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
        let image = UIImage(data: data)
      else {
        failed = true
        return
      }
      loaded = image
    } catch {
      failed = true
    }
  }
}

/// Blockquote: 2pt leading bar overlay, muted text (design doc appendix §1).
private struct MarkdownBlockquoteView: View {
  let text: String

  var body: some View {
    Text(attributedInlineMarkdown(text))
      .lineSpacing(markdownProseLineSpacing)
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
