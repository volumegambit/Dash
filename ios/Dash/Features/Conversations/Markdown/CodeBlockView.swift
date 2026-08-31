import SwiftUI

/// Fenced code block chrome: monospace text on a dark card, horizontal
/// scroll, no wrap. No syntax highlighting and no copy button in v1 — the
/// dependency-free highlighter is deferred (design doc Platform Adaptation
/// 1) — but the chrome/typography match MC's fenced-code treatment (design
/// doc appendix §2): background `#161B22`, no corner radius.
struct CodeBlockView: View {
  let code: String
  let language: String?

  var body: some View {
    ScrollView(.horizontal) {
      Text(code)
        .font(.system(.caption, design: .monospaced))
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.hidden)
    .padding(12)
    .background(codeBlockBackground)
  }

  private var codeBlockBackground: Color {
    Color(red: 0x16 / 255, green: 0x1b / 255, blue: 0x22 / 255)
  }
}
