import Foundation
import Testing

@testable import Dash

@Suite("Markdown block segmenter")
struct MarkdownBlocksTests {
  @Test("a plain paragraph with no special syntax segments as one paragraph block")
  func plainParagraph() {
    #expect(segmentMarkdown("Just some text.") == [.paragraph("Just some text.")])
  }

  @Test("blank lines split paragraphs")
  func blankLineSplitsParagraphs() {
    #expect(
      segmentMarkdown("para one\n\npara two")
        == [.paragraph("para one"), .paragraph("para two")]
    )
  }

  @Test("a soft-wrapped paragraph keeps its lines joined by newline")
  func softWrappedParagraphJoinsLines() {
    #expect(
      segmentMarkdown("line one\nline two")
        == [.paragraph("line one\nline two")]
    )
  }

  // MARK: - MC screenshot regression: **bold** must not render literal asterisks

  @Test("**bold** resolves to a bold AttributedString run, not literal asterisks")
  func boldResolvesToAttributedRun() {
    let attributed = attributedInlineMarkdown("This is **bold** text.")

    let plain = String(attributed.characters)
    #expect(!plain.contains("**"))
    #expect(plain == "This is bold text.")

    let hasBoldRun = attributed.runs.contains {
      $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
    }
    #expect(hasBoldRun)
  }

  @Test("*italic* resolves to an emphasized AttributedString run")
  func italicResolvesToAttributedRun() {
    let attributed = attributedInlineMarkdown("This is *italic* text.")
    let hasEmphasisRun = attributed.runs.contains {
      $0.inlinePresentationIntent?.contains(.emphasized) == true
    }
    #expect(hasEmphasisRun)
  }

  @Test("`inline code` is styled orange and monospaced")
  func inlineCodeIsStyledOrangeAndMono() {
    let attributed = attributedInlineMarkdown("Run `ls -la` now.")
    let codeRun = attributed.runs.first {
      $0.inlinePresentationIntent?.contains(.code) == true
    }
    #expect(codeRun != nil)
    #expect(codeRun?.foregroundColor == markdownInlineCodeColor)
  }

  @Test("malformed markdown falls back to plain, unstyled AttributedString")
  func malformedMarkdownFallsBackToPlain() {
    // An unterminated inline code span is a case AttributedString's
    // markdown initializer can throw on with .throwError.
    let attributed = attributedInlineMarkdown("Some `unterminated code span")
    #expect(String(attributed.characters) == "Some `unterminated code span")
  }

  // MARK: - Headings

  @Test(
    "ATX headings 1-4 parse with their level and text",
    arguments: [
      ("# Heading 1", 1, "Heading 1"),
      ("## Heading 2", 2, "Heading 2"),
      ("### Heading 3", 3, "Heading 3"),
      ("#### Heading 4", 4, "Heading 4"),
    ]
  )
  func atxHeadingLevels(input: String, level: Int, text: String) {
    #expect(segmentMarkdown(input) == [.heading(level: level, text: text)])
  }

  @Test("a run of 7+ # is not treated as a heading (GFM caps at 6)")
  func tooManyHashesIsParagraph() {
    #expect(segmentMarkdown("####### nope") == [.paragraph("####### nope")])
  }

  // MARK: - Bullets (incl. one nesting level)

  @Test("simple bullets with - marker")
  func simpleDashBullets() {
    #expect(
      segmentMarkdown("- one\n- two\n- three")
        == [bullets([li("one"), li("two"), li("three")])]
    )
  }

  @Test("simple bullets with * marker")
  func simpleStarBullets() {
    #expect(
      segmentMarkdown("* one\n* two")
        == [bullets([li("one"), li("two")])]
    )
  }

  @Test("mixed nested bullets: indented items get a two-space marker prefix")
  func mixedNestedBullets() {
    let input = """
      - top
        - nested one
        - nested two
      - top two
      """
    #expect(
      segmentMarkdown(input)
        == [bullets([li("top", children: [bullets([li("nested one"), li("nested two")])]), li("top two")])]
    )
  }

  @Test("a 4-space indent nests one level, not two (agents indent with 2 or 4 spaces interchangeably)")
  func fourSpaceIndentNestsOneLevel() {
    #expect(
      segmentMarkdown("- top\n    - deeply nested")
        == [bullets([li("top", children: [bullets([li("deeply nested")])])])]
    )
  }

  @Test("three levels of bullets nest under each other, and dedenting returns to the right ancestor")
  func threeLevelNesting() {
    #expect(
      segmentMarkdown("- a\n  - b\n    - c\n  - d\n- e")
        == [
          bullets([
            li("a", children: [bullets([li("b", children: [bullets([li("c")])]), li("d")])]),
            li("e"),
          ])
        ]
    )
  }

  @Test("an ordered list nests inside a bullet, and a bullet list inside an ordered item")
  func mixedNesting() {
    #expect(
      segmentMarkdown("- plan\n  1. first\n  2. second\n- go")
        == [bullets([li("plan", children: [ordered([li("first"), li("second")])]), li("go")])]
    )
    #expect(
      segmentMarkdown("1. outer\n   - inner")
        == [ordered([li("outer", children: [bullets([li("inner")])])])]
    )
  }

  @Test("an ordered list keeps its start number and 1) markers count as ordered")
  func orderedStartAndParenMarker() {
    #expect(segmentMarkdown("3. c\n4. d") == [ordered([li("c"), li("d")], start: 3)])
    #expect(segmentMarkdown("1) one\n2) two") == [ordered([li("one"), li("two")])])
  }

  @Test("+ is a bullet marker too")
  func plusMarker() {
    #expect(segmentMarkdown("+ one\n+ two") == [bullets([li("one"), li("two")])])
  }

  @Test("task items carry their checked state and drop the [ ]/[x] syntax from the text")
  func taskItems() {
    #expect(
      segmentMarkdown("- [ ] todo\n- [x] done\n- [X] also done")
        == [bullets([li("todo", checked: false), li("done", checked: true), li("also done", checked: true)])]
    )
  }

  @Test("an indented continuation line joins its list item instead of breaking the list")
  func continuationLine() {
    #expect(
      segmentMarkdown("- first line\n  wrapped\n- second")
        == [bullets([li("first line\nwrapped"), li("second")])]
    )
  }

  @Test("a blank line between items keeps one list (loose list), and a blank line before prose ends it")
  func looseListAndTermination() {
    #expect(
      segmentMarkdown("- a\n\n- b\n\nAfter.")
        == [bullets([li("a"), li("b")]), .paragraph("After.")]
    )
  }

  @Test("a fenced code block indented under a list item becomes that item's child block")
  func fenceInsideListItem() {
    #expect(
      segmentMarkdown("- run it\n  ```sh\n  make\n  ```\n- then")
        == [bullets([li("run it", children: [.fencedCode(language: "sh", code: "make")]), li("then")])]
    )
  }

  // MARK: - Tables (GFM pipe tables)

  @Test("a pipe table with a delimiter row segments into header, alignments, and rows")
  func pipeTable() {
    let md = "| Region | Status | Count |\n|:---|:---:|---:|\n| EU | Ready | 3 |\n| US | Pending | 12 |"
    #expect(
      segmentMarkdown(md)
        == [
          .table(
            MarkdownTable(
              header: ["Region", "Status", "Count"],
              alignments: [.left, .center, .right],
              rows: [["EU", "Ready", "3"], ["US", "Pending", "12"]]
            )
          )
        ]
    )
  }

  @Test("a table without outer pipes and with an escaped pipe in a cell still parses")
  func tableWithoutOuterPipes() {
    #expect(
      segmentMarkdown("a | b\n--- | ---\nx \\| y | z")
        == [.table(MarkdownTable(header: ["a", "b"], alignments: [.none, .none], rows: [["x | y", "z"]]))]
    )
  }

  @Test("a header line with no delimiter row yet (mid-stream) is still a paragraph, not a broken table")
  func tableHeaderOnlyWhileStreaming() {
    #expect(segmentMarkdown("| Region | Status |") == [.paragraph("| Region | Status |")])
  }

  @Test("a table ends at a blank line and prose resumes")
  func tableTermination() {
    #expect(
      segmentMarkdown("| a |\n|---|\n| 1 |\n\nDone.")
        == [.table(MarkdownTable(header: ["a"], alignments: [.none], rows: [["1"]])), .paragraph("Done.")]
    )
  }

  // MARK: - Headings 5–6, strikethrough, autolinks

  @Test("headings go to level 6 as in GFM; only 7+ # falls through to a paragraph")
  func headingLevels() {
    #expect(segmentMarkdown("##### five") == [.heading(level: 5, text: "five")])
    #expect(segmentMarkdown("###### six") == [.heading(level: 6, text: "six")])
    #expect(segmentMarkdown("####### seven") == [.paragraph("####### seven")])
  }

  @Test("~~strikethrough~~ resolves to a strikethrough run")
  func strikethroughRun() {
    let attributed = attributedInlineMarkdown("this is ~~gone~~ now")
    #expect(String(attributed.characters) == "this is gone now")
    #expect(attributed.runs.contains { $0.inlinePresentationIntent?.contains(.strikethrough) == true })
  }

  @Test("a bare URL in prose becomes a tappable link; an explicit [link](url) keeps its own")
  func bareURLAutolink() {
    let attributed = attributedInlineMarkdown("See https://example.com/docs?x=1 and [site](https://a.b).")
    let links = attributed.runs.compactMap { $0.link?.absoluteString }
    #expect(links.contains("https://example.com/docs?x=1"))
    #expect(links.contains("https://a.b"))
  }

  @Test("accessibility label reads nested list items and table cells as separate utterances")
  func accessibilityLabelForListsAndTables() {
    let label = markdownPlainTextAccessibilityLabel(
      for: "- a\n  - **b**\n\n| h1 | h2 |\n|---|---|\n| c1 | c2 |"
    )
    #expect(label == "a\nb\nh1, h2\nc1, c2")
  }

  // MARK: - Ordered lists

  @Test("ordered list items parse in sequence")
  func orderedList() {
    #expect(
      segmentMarkdown("1. first\n2. second\n3. third")
        == [ordered([li("first"), li("second"), li("third")])]
    )
  }

  // MARK: - Fenced code

  @Test("fenced code with a language tag")
  func fencedCodeWithLanguage() {
    let input = "```swift\nlet x = 1\n```"
    #expect(
      segmentMarkdown(input)
        == [.fencedCode(language: "swift", code: "let x = 1")]
    )
  }

  @Test("fenced code without a language tag")
  func fencedCodeWithoutLanguage() {
    let input = "```\nplain code\n```"
    #expect(
      segmentMarkdown(input)
        == [.fencedCode(language: nil, code: "plain code")]
    )
  }

  @Test("fenced code spanning multiple lines preserves internal blank lines")
  func fencedCodePreservesInternalBlankLines() {
    let input = "```\nline one\n\nline two\n```"
    #expect(
      segmentMarkdown(input)
        == [.fencedCode(language: nil, code: "line one\n\nline two")]
    )
  }

  @Test("an UNCLOSED fence at end-of-input still yields a fencedCode block (streaming)")
  func unclosedFenceAtEndOfInputYieldsCodeBlock() {
    let input = "```swift\nlet x = 1\nlet y = 2"
    #expect(
      segmentMarkdown(input)
        == [.fencedCode(language: "swift", code: "let x = 1\nlet y = 2")]
    )
  }

  @Test("an unclosed fence with no content yet still yields an empty fencedCode block")
  func unclosedEmptyFenceYieldsEmptyCodeBlock() {
    let input = "```swift"
    #expect(
      segmentMarkdown(input)
        == [.fencedCode(language: "swift", code: "")]
    )
  }

  // MARK: - Blockquote

  @Test("consecutive > lines join into one blockquote block")
  func blockquoteJoinsConsecutiveLines() {
    let input = "> line one\n> line two"
    #expect(
      segmentMarkdown(input)
        == [.blockquote("line one\nline two")]
    )
  }

  // MARK: - Horizontal rule

  @Test(
    "--- and *** both parse as a horizontal rule",
    arguments: ["---", "***", "___", "- - -"]
  )
  func horizontalRuleVariants(input: String) {
    #expect(segmentMarkdown(input) == [.horizontalRule])
  }

  // MARK: - Line ending normalization

  @Test("a CRLF document segments identically to its LF twin")
  func crlfDocumentMatchesLFTwin() {
    let lfInput = """
      # Title

      ```swift
      let x = 1
      ```

      ---

      - bullet one
      - bullet two
      """
    let crlfInput = lfInput.replacingOccurrences(of: "\n", with: "\r\n")

    #expect(segmentMarkdown(crlfInput) == segmentMarkdown(lfInput))
    #expect(
      segmentMarkdown(crlfInput)
        == [
          .heading(level: 1, text: "Title"),
          .fencedCode(language: "swift", code: "let x = 1"),
          .horizontalRule,
          bullets([li("bullet one"), li("bullet two")]),
        ]
    )
  }

  // MARK: - Interleaving

  @Test("a document mixing every block type segments in source order")
  func interleavedDocument() {
    let input = """
      # Title

      Intro paragraph.

      - bullet one
      - bullet two

      1. step one
      2. step two

      ```swift
      let x = 1
      ```

      > a quote

      ---

      Closing paragraph.
      """

    #expect(
      segmentMarkdown(input)
        == [
          .heading(level: 1, text: "Title"),
          .paragraph("Intro paragraph."),
          bullets([li("bullet one"), li("bullet two")]),
          ordered([li("step one"), li("step two")]),
          .fencedCode(language: "swift", code: "let x = 1"),
          .blockquote("a quote"),
          .horizontalRule,
          .paragraph("Closing paragraph."),
        ]
    )
  }

  // MARK: - markdownPlainTextAccessibilityLabel

  @Test("bold + inline code strip their markdown syntax for VoiceOver")
  func plainTextAccessibilityLabelStripsInlineSyntax() {
    #expect(markdownPlainTextAccessibilityLabel(for: "**Ship it** `now`") == "Ship it now")
  }

  @Test("multiple blocks become newline-separated lines")
  func plainTextAccessibilityLabelJoinsBlocksWithNewlines() {
    let input = "# Title\n\nIntro **bold** text.\n\n- one\n- two"
    #expect(
      markdownPlainTextAccessibilityLabel(for: input)
        == "Title\nIntro bold text.\none\ntwo"
    )
  }

  @Test("fenced code blocks use the raw code text, not markdown-parsed")
  func plainTextAccessibilityLabelUsesRawCodeForFences() {
    let input = "```swift\nlet x = **not bold**\n```"
    #expect(
      markdownPlainTextAccessibilityLabel(for: input) == "let x = **not bold**"
    )
  }

  @Test("horizontal rules contribute no text")
  func plainTextAccessibilityLabelDropsHorizontalRules() {
    #expect(markdownPlainTextAccessibilityLabel(for: "one\n\n---\n\ntwo") == "one\ntwo")
  }
}

// MARK: - Test helpers (iOS markdown parity, 2026-09-04)

/// Shorthand builders so list-shape assertions read like the source markdown.
func li(_ text: String, checked: Bool? = nil, children: [MarkdownBlock] = []) -> MarkdownListItem {
  MarkdownListItem(text: text, checked: checked, children: children)
}

func bullets(_ items: [MarkdownListItem]) -> MarkdownBlock {
  .list(MarkdownList(ordered: false, start: 1, items: items))
}

func ordered(_ items: [MarkdownListItem], start: Int = 1) -> MarkdownBlock {
  .list(MarkdownList(ordered: true, start: start, items: items))
}
