import SwiftUI

struct AssistantEventViews: View {
  let projection: AssistantMessageProjection
  let onAnswer: (String, String) -> Void
  let exposesResponseToAccessibility: Bool

  init(
    projection: AssistantMessageProjection,
    onAnswer: @escaping (String, String) -> Void = { _, _ in },
    exposesResponseToAccessibility: Bool
  ) {
    self.projection = projection
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
        Text(projection.text)
          .textSelection(.enabled)
          .accessibilityHidden(!exposesResponseToAccessibility)
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
        QuestionView(question: question, onAnswer: onAnswer)
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
    DisclosureGroup(isExpanded: $isExpanded) {
      Text(thinking)
        .font(.callout)
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
        .padding(.top, 4)
    } label: {
      Label("Thinking", systemImage: "brain.head.profile")
        .font(.callout.weight(.semibold))
    }
    .onChange(of: isCollapsed) { _, collapsed in
      isExpanded = !collapsed
    }
    .accessibilityElement(children: .contain)
  }
}

struct ToolCardView: View {
  let tool: ToolCardState

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label(tool.status.title, systemImage: tool.status.systemImage)
        .font(.callout.weight(.semibold))

      Text(tool.name)
        .font(.subheadline.monospaced())

      if let input = tool.input {
        LabeledContent("Input") {
          Text(displayJSON(input))
            .multilineTextAlignment(.trailing)
            .textSelection(.enabled)
        }
        .font(.caption)
      }

      if !tool.partialJSON.isEmpty {
        Text(tool.partialJSON)
          .font(.caption.monospaced())
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
      }

      if let content = tool.content, !content.isEmpty {
        Text(content)
          .font(.callout)
          .textSelection(.enabled)
      }

      if let details = tool.details {
        Text(displayJSON(details))
          .font(.caption.monospaced())
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
      }
    }
    .padding(10)
    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Tool \(tool.name), \(tool.status.title)")
  }
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
  }
}

struct QuestionView: View {
  let question: QuestionState
  let onAnswer: (String, String) -> Void

  @State private var draft: QuestionDraftState

  init(question: QuestionState, onAnswer: @escaping (String, String) -> Void) {
    self.question = question
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
          .disabled(question.answer != nil)
        }
      }

      HStack(alignment: .bottom) {
        TextField("Type an answer", text: $draft.text, axis: .vertical)
          .textFieldStyle(.roundedBorder)
          .frame(minHeight: 44)
          .disabled(question.answer != nil)

        Button("Send") {
          onAnswer(question.id, draft.text)
        }
        .buttonStyle(.borderedProminent)
        .frame(minHeight: 44)
        .disabled(
          question.answer != nil
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

private func displayJSON(_ value: JSONValue) -> String {
  guard
    let data = try? ContractCoding.encoder().encode(value),
    let string = String(data: data, encoding: .utf8)
  else {
    return "JSON value"
  }
  return string
}
