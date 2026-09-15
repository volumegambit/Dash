import CoreTransferable
import SwiftUI
import UIKit
import UniformTypeIdentifiers

enum AssistantTimelineSection: Equatable {
  case content(index: Int, block: AssistantTimelineBlock)
  case activity(id: Int, blocks: [AssistantTimelineBlock])
}

/// Consecutive implementation details collapse into one transcript row.
/// Prose, questions, and sub-agent groups remain at their original positions.
func assistantTimelineSections(_ timeline: [AssistantTimelineBlock]) -> [AssistantTimelineSection] {
  var sections: [AssistantTimelineSection] = []
  var activity: [AssistantTimelineBlock] = []
  var activityStart = 0

  func flushActivity() {
    guard activity.isEmpty == false else { return }
    sections.append(.activity(id: activityStart, blocks: activity))
    activity.removeAll(keepingCapacity: true)
  }

  for (index, block) in timeline.enumerated() {
    switch block {
    case .thinking, .tool, .status:
      if activity.isEmpty { activityStart = index }
      activity.append(block)
    case .text, .question, .subagents:
      flushActivity()
      sections.append(.content(index: index, block: block))
    }
  }
  flushActivity()
  return sections
}

struct ActivityGroupView: View {
  let blocks: [AssistantTimelineBlock]
  let identifierPrefix: String
  let activityIndex: Int
  let onOpenInspector: (String, String) -> Void
  let onDismissInspector: () -> Void

  @State private var showsInspector = false
  @AccessibilityFocusState private var isAccessibilityFocused: Bool
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  var body: some View {
    Button {
      onOpenInspector(activityID, activityID)
      showsInspector = true
    } label: {
      HStack(spacing: 8) {
        statusGlyph
        VStack(alignment: .leading, spacing: 1) {
          Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.primary)
          Text(summary)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        Spacer(minLength: 8)
        Image(systemName: "chevron.right")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.tertiary)
      }
      .padding(.horizontal, 11)
      .padding(.vertical, 9)
      .background(
        Color.secondary.opacity(DashTheme.Opacity.fillSubtle),
        in: RoundedRectangle(cornerRadius: DashTheme.Radius.medium)
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(title), \(summary)")
    .accessibilityHint("Opens agent activity details")
    .accessibilityIdentifier(activityID)
    .accessibilityFocused($isAccessibilityFocused)
    .activityInspector(
      isPresented: $showsInspector,
      usesColumn: horizontalSizeClass == .regular
    ) {
      ActivityInspectorView(
        blocks: blocks,
        identifierPrefix: activityID
      )
    }
    .onChange(of: showsInspector) { wasPresented, isPresented in
      guard wasPresented, isPresented == false else { return }
      onDismissInspector()
      isAccessibilityFocused = true
    }
  }

  private var activityID: String {
    "\(identifierPrefix).activity.\(activityIndex)"
  }

  private var tools: [ToolCardState] {
    blocks.compactMap { if case .tool(let tool) = $0 { tool } else { nil } }
  }

  private var hasThinking: Bool {
    blocks.contains { if case .thinking = $0 { true } else { false } }
  }

  private var title: String {
    if tools.isEmpty, hasThinking { return "Thinking" }
    if tools.contains(where: { $0.status == .running }) { return "Working" }
    return "Activity"
  }

  private var summary: String {
    let failed = tools.filter { $0.status == .failed }.count
    if failed > 0 { return "\(failed) failed · \(stepCount) steps" }
    if let running = tools.last(where: { $0.status == .running }) {
      return ToolPresentation.summarize(name: running.name, input: running.input)
        ?? ToolPresentation.toolLabel(running.name)
    }
    return "\(stepCount) step\(stepCount == 1 ? "" : "s")"
  }

  private var stepCount: Int {
    max(tools.count + blocks.filter { if case .status = $0 { true } else { false } }.count, 1)
  }

  @ViewBuilder
  private var statusGlyph: some View {
    if tools.contains(where: { $0.status == .failed }) {
      Image(systemName: "exclamationmark.circle.fill")
        .foregroundStyle(DashTheme.danger)
    } else if tools.contains(where: { $0.status == .running }) {
      ProgressView().controlSize(.small)
    } else if tools.isEmpty, hasThinking {
      Image(systemName: "brain.head.profile")
        .foregroundStyle(.secondary)
    } else {
      Image(systemName: "checkmark.circle.fill")
        .foregroundStyle(DashTheme.success)
    }
  }
}

private extension View {
  /// A side inspector keeps the transcript visible on wide iPad layouts;
  /// compact layouts use the familiar native sheet. Both own their own scroll
  /// position and dismiss back to the Activity trigger.
  @ViewBuilder
  func activityInspector<Content: View>(
    isPresented: Binding<Bool>,
    usesColumn: Bool,
    @ViewBuilder content: @escaping () -> Content
  ) -> some View {
    if usesColumn {
      inspector(isPresented: isPresented) {
        content()
          .inspectorColumnWidth(min: 320, ideal: 400, max: 520)
      }
    } else {
      sheet(isPresented: isPresented, content: content)
    }
  }
}

private struct ActivityInspectorView: View {
  let blocks: [AssistantTimelineBlock]
  let identifierPrefix: String
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
            switch block {
            case .thinking(let thinking):
              VStack(alignment: .leading, spacing: 6) {
                Label("Model thinking", systemImage: "brain.head.profile")
                  .font(.subheadline.weight(.semibold))
                Text(thinking)
                  .font(.callout)
                  .foregroundStyle(.secondary)
                  .textSelection(.enabled)
              }
              .padding(12)
              .background(
                Color.secondary.opacity(DashTheme.Opacity.fillSubtle),
                in: RoundedRectangle(cornerRadius: DashTheme.Radius.medium)
              )
            case .tool(let tool):
              ToolCardView(tool: tool, identifierPrefix: "\(identifierPrefix).inspector")
            case .status(let row):
              StatusRowView(row: row)
            case .text, .subagents, .question:
              EmptyView()
            }
          }
        }
        .padding()
        .frame(maxWidth: DashTheme.Layout.readableWidth)
        .frame(maxWidth: .infinity)
      }
      .navigationTitle("Activity")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }
}

enum LongMessagePresentation {
  static let previewThreshold = 8_000
  static let previewLength = 4_000
  static let pasteboardByteLimit = 4 * 1_024 * 1_024

  static func needsReader(_ text: String) -> Bool { text.count > previewThreshold }

  static func preview(_ text: String) -> String {
    guard needsReader(text) else { return text }
    return String(text.prefix(previewLength))
  }

  static func accessibilityPreview(_ text: String) -> String {
    let plain = markdownPlainTextAccessibilityLabel(for: text)
    guard needsReader(text) else { return plain }
    return "\(String(plain.prefix(previewLength))). Continue reading for the complete response."
  }

  static func fitsPasteboard(_ text: String) -> Bool {
    text.utf8.count <= pasteboardByteLimit
  }
}

private struct LongMessageExport: Transferable, Sendable {
  let text: String

  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(exportedContentType: .plainText) { value in
      let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("Dash Response \(UUID().uuidString).txt")
      try value.text.write(to: url, atomically: true, encoding: .utf8)
      return SentTransferredFile(url)
    }
  }
}

struct LongMessageView: View {
  let text: String
  let exposesResponseToAccessibility: Bool
  let accessibilityIdentifier: String
  let accessibilityLabel: String?
  @State private var showsReader = false

  init(
    text: String,
    exposesResponseToAccessibility: Bool,
    accessibilityIdentifier: String,
    accessibilityLabel: String? = nil
  ) {
    self.text = text
    self.exposesResponseToAccessibility = exposesResponseToAccessibility
    self.accessibilityIdentifier = accessibilityIdentifier
    self.accessibilityLabel = accessibilityLabel
  }

  var body: some View {
    if LongMessagePresentation.needsReader(text) {
      VStack(alignment: .leading, spacing: 10) {
        MarkdownTextView(text: LongMessagePresentation.preview(text))
          .textSelection(.enabled)
          .accessibilityHidden(exposesResponseToAccessibility == false)
        Button("Continue reading") { showsReader = true }
          .font(.subheadline.weight(.semibold))
          .buttonStyle(.bordered)
          .accessibilityHint("Opens the complete response in a reading view")
      }
      .accessibilityIdentifier(accessibilityIdentifier)
      .accessibilityElement(children: .combine)
      .accessibilityLabel(
        LongMessagePresentation.accessibilityPreview(accessibilityLabel ?? text)
      )
      .accessibilityHidden(exposesResponseToAccessibility == false)
      .sheet(isPresented: $showsReader) {
        LongContentReader(text: text, rendersMarkdown: true)
      }
    } else if exposesResponseToAccessibility {
      MarkdownTextView(text: text)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
          markdownPlainTextAccessibilityLabel(for: accessibilityLabel ?? text)
        )
        .accessibilityIdentifier(accessibilityIdentifier)
    } else {
      MarkdownTextView(text: text).accessibilityHidden(true)
    }
  }
}

struct LongPlainMessageView: View {
  let text: String
  @State private var showsReader = false

  var body: some View {
    if LongMessagePresentation.needsReader(text) {
      VStack(alignment: .leading, spacing: 10) {
        Text(LongMessagePresentation.preview(text))
          .textSelection(.enabled)
        Button("Continue reading") { showsReader = true }
          .font(.subheadline.weight(.semibold))
          .buttonStyle(.bordered)
      }
      .sheet(isPresented: $showsReader) {
        LongContentReader(text: text, rendersMarkdown: false)
      }
    } else {
      Text(text).textSelection(.enabled)
    }
  }
}

private struct LongContentReader: View {
  let text: String
  let rendersMarkdown: Bool
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        Group {
          if rendersMarkdown {
            MarkdownTextView(text: text)
          } else {
            Text(text)
          }
        }
        .textSelection(.enabled)
        .padding()
        .frame(maxWidth: DashTheme.Layout.readableWidth)
        .frame(maxWidth: .infinity)
      }
      .navigationTitle("Response")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          if LongMessagePresentation.fitsPasteboard(text) {
            Button {
              UIPasteboard.general.string = markdownPlainTextAccessibilityLabel(for: text)
            } label: {
              Label("Copy", systemImage: "doc.on.doc")
            }
          } else {
            ShareLink(
              item: LongMessageExport(text: text),
              preview: SharePreview("Dash response", image: Image(systemName: "doc.text"))
            ) {
              Label("Share file", systemImage: "square.and.arrow.up")
            }
          }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }
}
