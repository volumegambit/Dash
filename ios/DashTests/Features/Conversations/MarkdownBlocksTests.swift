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

  @Test("a run of 5+ # is not treated as a heading")
  func tooManyHashesIsNotAHeading() {
    #expect(segmentMarkdown("##### not a heading") == [.paragraph("##### not a heading")])
  }

  // MARK: - Bullets (incl. one nesting level)

  @Test("simple bullets with - marker")
  func simpleDashBullets() {
    #expect(
      segmentMarkdown("- one\n- two\n- three")
        == [.bullets(["one", "two", "three"])]
    )
  }

  @Test("simple bullets with * marker")
  func simpleStarBullets() {
    #expect(
      segmentMarkdown("* one\n* two")
        == [.bullets(["one", "two"])]
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
        == [.bullets(["top", "  nested one", "  nested two", "top two"])]
    )
  }

  @Test("deeper-than-one indent still collapses to a single nesting level")
  func deeplyNestedBulletCollapsesToOneLevel() {
    let input = """
      - top
          - deeply nested
      """
    #expect(
      segmentMarkdown(input)
        == [.bullets(["top", "  deeply nested"])]
    )
  }

  // MARK: - Ordered lists

  @Test("ordered list items parse in sequence")
  func orderedList() {
    #expect(
      segmentMarkdown("1. first\n2. second\n3. third")
        == [.ordered(["first", "second", "third"])]
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
          .bullets(["bullet one", "bullet two"]),
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
          .bullets(["bullet one", "bullet two"]),
          .ordered(["step one", "step two"]),
          .fencedCode(language: "swift", code: "let x = 1"),
          .blockquote("a quote"),
          .horizontalRule,
          .paragraph("Closing paragraph."),
        ]
    )
  }
}
