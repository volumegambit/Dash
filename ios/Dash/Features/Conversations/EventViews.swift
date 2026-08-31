import SwiftUI

struct AssistantEventViews: View {
  let projection: AssistantMessageProjection
  let isAnsweringEnabled: Bool
  let onAnswer: (String, String) -> Void
  let exposesResponseToAccessibility: Bool

  init(
    projection: AssistantMessageProjection,
    isAnsweringEnabled: Bool = true,
    onAnswer: @escaping (String, String) -> Void = { _, _ in },
    exposesResponseToAccessibility: Bool
  ) {
    self.projection = projection
    self.isAnsweringEnabled = isAnsweringEnabled
    self.onAnswer = onAnswer
    self.exposesResponseToAccessibility = exposesResponseToAccessibility
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if !projection.thinking.isEmpty {
        ThinkingView(
          thinking: projection.thinking,
          isCollapsed: projection.isThinkingCollapsed
        )
      }

      if !projection.text.isEmpty {
        if exposesResponseToAccessibility {
          MarkdownTextView(text: projection.text)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(projection.text)
            .accessibilityIdentifier("chat.final.response")
        } else {
          MarkdownTextView(text: projection.text)
            .accessibilityHidden(true)
        }
      }

      ForEach(projection.toolCards) { tool in
        ToolCardView(tool: tool)
      }

      ForEach(projection.workerCards) { worker in
        WorkerCardView(worker: worker)
      }

      ForEach(projection.statusRows) { row in
        if row.kind == .unknown {
          UnknownEventView(type: row.unknownType ?? "unknown")
        } else {
          StatusRowView(row: row)
        }
      }

      if let question = projection.pendingQuestion {
        QuestionView(
          question: question,
          isAnsweringEnabled: isAnsweringEnabled,
          onAnswer: onAnswer
        )
      }

      if let usage = projection.usage {
        UsageView(usage: usage)
      }

      if let terminal = projection.terminal {
        TerminalView(terminal: terminal)
      }
    }
  }
}

/// MC parity (design doc appendix §4): default collapsed, toggle copy exactly
/// "Show thinking"/"Hide thinking", expanded body is plain muted text (not
/// markdown, not italic). `isCollapsed` seeds the initial `isExpanded`
/// @State once; unlike the pre-MC-parity version, streaming thinking deltas
/// no longer force it open — MC's `ThinkingBlock` always starts collapsed
/// and only the user's tap toggles it (see `ChatReducer.project`'s
/// `.thinkingDelta` case, which no longer flips `isThinkingCollapsed`).
struct ThinkingView: View {
  let thinking: String
  let isCollapsed: Bool

  @State private var isExpanded: Bool

  init(thinking: String, isCollapsed: Bool) {
    self.thinking = thinking
    self.isCollapsed = isCollapsed
    _isExpanded = State(initialValue: !isCollapsed)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Button {
        isExpanded.toggle()
      } label: {
        Text(isExpanded ? "Hide thinking" : "Show thinking")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .buttonStyle(.plain)

      if isExpanded {
        Text(thinking)
          .font(.caption)
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
      }
    }
    .accessibilityElement(children: .contain)
  }
}

/// MC parity (design doc appendix §3): collapsed-by-default card with a
/// status-glyph + mono tool label + inline summary header; expanded body
/// shows `formatDetails` key/value rows followed by the result (error /
/// empty / short-green / scrollable). Diff rendering, directory listings,
/// numbered-source gutters, and rich write-content previews are explicitly
/// out of iOS scope (design doc "Out of scope" + Platform Adaptation 1) —
/// the result here only branches on error/empty/short/long.
struct ToolCardView: View {
  let tool: ToolCardState

  @State private var isExpanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        isExpanded.toggle()
      } label: {
        header
      }
      .buttonStyle(.plain)

      if isExpanded {
        expandedBody
          .padding(.top, 6)
      }
    }
    .padding(10)
    .background(cardBackground, in: RoundedRectangle(cornerRadius: 8))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Tool \(ToolPresentation.toolLabel(tool.name)), \(tool.status.title)")
    .accessibilityIdentifier("chat.tool.\(tool.id)")
  }

  private var header: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      statusGlyph
      Text(ToolPresentation.toolLabel(tool.name))
        .font(.callout.monospaced())
        .foregroundStyle(.primary)
      if let summary = ToolPresentation.summarize(name: tool.name, input: tool.input) {
        Text(summary)
          .font(isBash ? .caption.monospaced() : .caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.tail)
      }
      Spacer(minLength: 0)
    }
  }

  private var isBash: Bool {
    ToolPresentation.normalizeTool(tool.name) == "bash"
  }

  @ViewBuilder
  private var statusGlyph: some View {
    switch tool.status {
    case .running:
      ProgressView()
        .controlSize(.mini)
        .frame(width: 12, height: 12)
    case .succeeded:
      Circle()
        .fill(EventViewColors.green)
        .frame(width: 8, height: 8)
    case .failed:
      Image(systemName: "xmark.circle")
        .font(.system(size: 10))
        .foregroundStyle(EventViewColors.red)
    }
  }

  private var cardBackground: Color {
    tool.status == .failed ? EventViewColors.red.opacity(0.08) : Color.secondary.opacity(0.08)
  }

  @ViewBuilder
  private var expandedBody: some View {
    VStack(alignment: .leading, spacing: 4) {
      let details = ToolPresentation.formatDetails(name: tool.name, input: tool.input)
      ForEach(details, id: \.key) { detail in
        Text("\(capitalizedFirstLetter(detail.key)): \(detail.value)")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      resultView
    }
  }

  @ViewBuilder
  private var resultView: some View {
    switch tool.status {
    case .running:
      EmptyView()

    case .failed:
      Text(tool.content ?? "")
        .font(.caption.monospaced())
        .foregroundStyle(EventViewColors.red)
        .textSelection(.enabled)

    case .succeeded:
      let content = tool.content ?? ""
      if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        Text("No output")
          .font(.caption)
          .italic()
          .foregroundStyle(.secondary)
      } else if content.components(separatedBy: "\n").count <= 3 {
        Text(content)
          .font(.caption.monospaced())
          .foregroundStyle(EventViewColors.green.opacity(0.8))
          .textSelection(.enabled)
      } else {
        ScrollView {
          Text(content)
            .font(.caption.monospaced())
            .foregroundStyle(.primary.opacity(0.8))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
        }
        .frame(maxHeight: 256)
        .background(EventViewColors.codeBackground)
      }
    }
  }
}

/// CSS `text-transform: capitalize`-equivalent for a single detail key:
/// uppercase the first character only, leave the rest untouched. (Swift's
/// `String.capitalized` also lowercases the remainder of the "word", which
/// would mangle camelCase keys like `filePath` into `Filepath`.)
private func capitalizedFirstLetter(_ s: String) -> String {
  guard let first = s.first else { return s }
  return first.uppercased() + s.dropFirst()
}

/// MC design tokens (design doc appendix §0) needed for tool-card chrome
/// that has no existing Dash design-system token.
private enum EventViewColors {
  static let green = Color(red: 0x22 / 255, green: 0xc5 / 255, blue: 0x5e / 255)
  static let red = Color(red: 0xf8 / 255, green: 0x71 / 255, blue: 0x71 / 255)
  static let codeBackground = Color(red: 0x16 / 255, green: 0x1b / 255, blue: 0x22 / 255)
}

struct WorkerCardView: View {
  let worker: WorkerCardState

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label(worker.status.title, systemImage: worker.status.systemImage)
        .font(.callout.weight(.semibold))

      Text(worker.role)
        .font(.subheadline.weight(.medium))

      if let brief = worker.brief, !brief.isEmpty {
        Text(brief)
          .font(.callout)
      }

      if let model = worker.model, !model.isEmpty {
        Label(model, systemImage: "cpu")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      if let detail = worker.detail, !detail.isEmpty {
        Text(detail)
          .font(.callout)
      }

      if let question = worker.question, !question.isEmpty {
        Label(question, systemImage: "questionmark.bubble")
          .font(.callout)
      }

      if let report = worker.report, !report.isEmpty {
        Text(report)
          .font(.callout)
          .textSelection(.enabled)
      }

      if let usage = worker.usage {
        UsageView(usage: usage)
      }
    }
    .padding(10)
    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Worker \(worker.role), \(worker.status.title)")
    .accessibilityIdentifier("chat.worker.\(worker.key.workerID)")
  }
}

struct QuestionView: View {
  let question: QuestionState
  let isAnsweringEnabled: Bool
  let onAnswer: (String, String) -> Void

  @State private var draft: QuestionDraftState

  init(
    question: QuestionState,
    isAnsweringEnabled: Bool = true,
    onAnswer: @escaping (String, String) -> Void
  ) {
    self.question = question
    self.isAnsweringEnabled = isAnsweringEnabled
    self.onAnswer = onAnswer
    _draft = State(initialValue: QuestionDraftState(question: question))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Label("Question", systemImage: "questionmark.bubble")
        .font(.callout.weight(.semibold))

      Text(question.question)

      if !question.options.isEmpty {
        ForEach(question.options, id: \.self) { option in
          Button(option) {
            onAnswer(question.id, option)
          }
          .buttonStyle(.bordered)
          .frame(minHeight: 44)
          .disabled(isAnsweringEnabled == false || question.answer != nil)
        }
      }

      HStack(alignment: .bottom) {
        TextField("Type an answer", text: $draft.text, axis: .vertical)
          .textFieldStyle(.roundedBorder)
          .frame(minHeight: 44)
          .disabled(isAnsweringEnabled == false || question.answer != nil)

        Button("Send") {
          onAnswer(question.id, draft.text)
        }
        .buttonStyle(.borderedProminent)
        .frame(minHeight: 44)
        .disabled(
          isAnsweringEnabled == false
            || question.answer != nil
            || draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        )
      }

      if let answer = question.answer {
        Label("Answered: \(answer)", systemImage: "checkmark.circle.fill")
          .font(.callout)
      }
    }
    .padding(10)
    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("chat.question.\(question.id)")
    .onChange(of: question.id) { _, _ in
      draft.reconcile(with: question)
    }
  }
}

struct QuestionDraftState: Equatable {
  private(set) var questionID: String
  var text: String

  init(question: QuestionState) {
    questionID = question.id
    text = question.answer ?? ""
  }

  mutating func reconcile(with question: QuestionState) {
    guard question.id != questionID else { return }
    self = QuestionDraftState(question: question)
  }
}

struct StatusRowView: View {
  let row: StatusRowState

  var body: some View {
    Label {
      VStack(alignment: .leading, spacing: 2) {
        Text(row.title)
          .font(.callout.weight(.medium))
        if let detail = row.detail, !detail.isEmpty {
          Text(detail)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
    } icon: {
      Image(systemName: row.kind.systemImage)
    }
    .accessibilityElement(children: .combine)
  }
}

struct UnknownEventView: View {
  let type: String

  var body: some View {
    Label("Gateway event: \(type)", systemImage: "questionmark.diamond")
      .font(.callout)
      .foregroundStyle(.secondary)
      .accessibilityElement(children: .combine)
  }
}

struct UsageView: View {
  let usage: UsageDTO

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Label("Usage", systemImage: "gauge.with.dots.needle.67percent")
        .font(.caption.weight(.semibold))
      Text("Input: \(usage.inputTokens) tokens")
      Text("Output: \(usage.outputTokens) tokens")
      if let cacheReadTokens = usage.cacheReadTokens {
        Text("Cache read: \(cacheReadTokens) tokens")
      }
      if let cacheWriteTokens = usage.cacheWriteTokens {
        Text("Cache write: \(cacheWriteTokens) tokens")
      }
    }
    .font(.caption)
    .foregroundStyle(.secondary)
    .accessibilityElement(children: .combine)
  }
}

struct TerminalView: View {
  let terminal: ChatTerminalState

  var body: some View {
    Label(terminal.title, systemImage: terminal.systemImage)
      .font(.callout.weight(.semibold))
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isHeader)
  }
}

extension ToolCardStatus {
  fileprivate var title: String {
    switch self {
    case .running: "Tool running"
    case .succeeded: "Tool succeeded"
    case .failed: "Tool failed"
    }
  }

  fileprivate var systemImage: String {
    switch self {
    case .running: "gearshape.2"
    case .succeeded: "checkmark.circle.fill"
    case .failed: "xmark.octagon.fill"
    }
  }
}

extension WorkerCardStatus {
  fileprivate var title: String {
    switch self {
    case .running: "Worker running"
    case .waitingInput: "Worker waiting for input"
    case .done: "Worker completed"
    case .failed: "Worker failed"
    case .cancelled: "Worker cancelled"
    }
  }

  fileprivate var systemImage: String {
    switch self {
    case .running: "person.crop.circle.badge.clock"
    case .waitingInput: "person.crop.circle.badge.questionmark"
    case .done: "person.crop.circle.badge.checkmark"
    case .failed: "person.crop.circle.badge.exclamationmark"
    case .cancelled: "person.crop.circle.badge.xmark"
    }
  }
}

extension StatusRowKind {
  fileprivate var systemImage: String {
    switch self {
    case .agentError: "exclamationmark.triangle.fill"
    case .filesChanged: "doc.badge.gearshape"
    case .agentSpawned: "person.crop.circle.badge.plus"
    case .retry: "arrow.clockwise"
    case .contextCompacted: "rectangle.compress.vertical"
    case .skillLoaded: "books.vertical"
    case .skillCreated: "wand.and.stars"
    case .mcpError: "network.badge.shield.half.filled"
    case .unknown: "questionmark.diamond"
    }
  }
}

extension ChatTerminalState {
  fileprivate var title: String {
    switch self {
    case .completed: "Response completed"
    case .cancelled: "Response cancelled"
    case let .failed(error): "Response failed: \(error)"
    case .interrupted: "Response interrupted"
    }
  }

  fileprivate var systemImage: String {
    switch self {
    case .completed: "checkmark.circle.fill"
    case .cancelled: "xmark.circle"
    case .failed: "exclamationmark.octagon.fill"
    case .interrupted: "pause.circle"
    }
  }
}
