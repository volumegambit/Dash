import SwiftUI

struct ChatControlStrip: View {
  @Environment(ChatFeature.self) private var feature
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  let priority: ChatControlPriority
  let openPending: () -> Void
  let reviewRequiredInput: () -> Void

  @ViewBuilder
  var body: some View {
    switch priority {
    case .requiredInput(let count):
      requiredInputStrip(count: count)
    case .work, .pausedPending, .stopping:
      if feature.conversationControlAvailable {
        workStrip
      }
    case .recovery, .none:
      EmptyView()
    }
  }

  private var workStrip: some View {
    HStack(spacing: 10) {
      if case .stopping = priority {
        ProgressView()
          .controlSize(.small)
          .accessibilityHidden(true)
        Text("Stopping")
          .font(.subheadline.weight(.semibold))
      } else {
        if feature.state.activeTurnID != nil {
          ProgressView()
            .controlSize(.small)
            .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 1) {
            Text("Working")
              .font(.subheadline.weight(.semibold))
            if feature.state.queue.pendingCount > 0 {
              Text(followUpCount)
                .font(.caption)
                .foregroundStyle(.secondary)
            }
          }
        } else {
          Image(systemName: feature.state.queue.scheduling == .paused ? "pause.fill" : "text.line.last.and.arrowtriangle.forward")
            .foregroundStyle(feature.state.queue.scheduling == .paused ? Color.orange : DashTheme.accent)
            .accessibilityHidden(true)
          Text(feature.state.queue.scheduling == .paused ? "Follow Ups paused" : followUpCount)
            .font(.subheadline.weight(.semibold))
        }
      }

      Spacer(minLength: 8)

      if feature.state.queue.pendingCount > 0 {
        Button("View", action: openPending)
          .buttonStyle(.bordered)
          .controlSize(.small)
          .accessibilityHint("Review, edit, or remove pending Follow Ups")
      }

      if feature.canResumePending {
        Button("Resume") { Task { await feature.resumePending() } }
          .buttonStyle(.borderedProminent)
          .controlSize(.small)
      } else if feature.state.activeTurnID != nil, feature.isCancelling == false {
        stopButton
      }
    }
    .chatControlStripStyle(reduceMotion: reduceMotion, animationValue: priority)
  }

  private func requiredInputStrip(count: Int) -> some View {
    HStack(spacing: 10) {
      Image(systemName: "questionmark.circle.fill")
        .foregroundStyle(DashTheme.accent)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text(count == 1 ? "Needs your input" : "Needs your input · \(count)")
          .font(.subheadline.weight(.semibold))
        Text("The response is waiting for an answer")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer(minLength: 8)
      Button("Review", action: reviewRequiredInput)
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
      if feature.state.activeTurnID != nil, feature.isCancelling == false {
        stopButton
      }
    }
    .chatControlStripStyle(reduceMotion: reduceMotion, animationValue: count)
  }

  private var stopButton: some View {
    Button(role: .destructive) {
      Task { await feature.stopConversation() }
    } label: {
      Label("Stop", systemImage: "stop.fill")
    }
    .buttonStyle(.bordered)
    .controlSize(.small)
    .disabled(feature.canStopConversation == false)
    .accessibilityHint("Stops the active response and pauses pending Follow Ups")
  }

  private var followUpCount: String {
    let count = feature.state.queue.pendingCount
    return "\(count) Follow Up\(count == 1 ? "" : "s")"
  }
}

private extension View {
  func chatControlStripStyle<T: Equatable>(
    reduceMotion: Bool,
    animationValue: T
  ) -> some View {
    self
      .padding(.horizontal, 14)
      .padding(.vertical, 9)
      .background(.thinMaterial)
      .overlay(alignment: .top) { Divider() }
      .contentTransition(.opacity)
      .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: animationValue)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("chat.controlStrip")
  }
}

struct PendingWorkSheet: View {
  @Environment(ChatFeature.self) private var feature
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Group {
        if feature.state.queue.items.isEmpty {
          ContentUnavailableView(
            "No Follow Ups",
            systemImage: "text.line.last.and.arrowtriangle.forward",
            description: Text("New Follow Ups will appear here on every connected device.")
          )
        } else {
          List(feature.state.queue.items) { item in
            PendingWorkRow(item: item)
          }
          .listStyle(.insetGrouped)
        }
      }
      .navigationTitle("Follow Ups")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }
}

private struct PendingWorkRow: View {
  @Environment(ChatFeature.self) private var feature
  let item: PendingConversationInputDTO
  @State private var text: String
  @State private var baseText: String
  @State private var isEditing = false
  @State private var isSaving = false
  @State private var conflictMessage: String?

  init(item: PendingConversationInputDTO) {
    self.item = item
    _text = State(initialValue: item.text)
    _baseText = State(initialValue: item.text)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Label(item.kind == .priority ? "Priority" : "Follow Up", systemImage: item.kind == .priority ? "bolt.fill" : "clock")
          .font(.caption.weight(.semibold))
          .foregroundStyle(item.kind == .priority ? Color.orange : Color.secondary)
        Spacer()
        if item.state == .claimed {
          Text("Starting")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }

      if isEditing {
        TextField("Follow Up", text: $text, axis: .vertical)
          .lineLimit(2...8)
          .textFieldStyle(.roundedBorder)
        HStack {
          Button("Cancel") {
            text = item.text
            baseText = item.text
            conflictMessage = nil
            isEditing = false
          }
          Spacer()
          Button {
            isSaving = true
            conflictMessage = nil
            Task {
              await feature.editPending(item, text: text)
              isSaving = false
            }
          } label: {
            if isSaving {
              ProgressView()
            } else {
              Text("Save")
            }
          }
          .buttonStyle(.borderedProminent)
          .disabled(
            isSaving || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          )
        }
        if let conflictMessage {
          Text(conflictMessage)
            .font(.caption)
            .foregroundStyle(.orange)
            .accessibilityIdentifier("chat.pending.editConflict")
        }
      } else {
        Text(item.text)
          .font(.body)
          .textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
        if item.images?.isEmpty == false {
          Label("Includes images", systemImage: "photo.on.rectangle")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      if item.state == .pending {
        Button(role: .destructive) {
          Task { await feature.removePending(item) }
        } label: {
          Label("Remove", systemImage: "trash")
        }
        Button {
          baseText = item.text
          text = item.text
          conflictMessage = nil
          isEditing = true
        } label: {
          Label("Edit", systemImage: "pencil")
        }
        .tint(DashTheme.accent)
      }
    }
    .onChange(of: item.version) { _, _ in
      let editedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
      let canonicalText = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
      if isEditing, editedText != baseText.trimmingCharacters(in: .whitespacesAndNewlines),
        editedText != canonicalText
      {
        baseText = item.text
        conflictMessage = "Changed on another device. Your edit is preserved; review and save again."
      } else {
        text = item.text
        baseText = item.text
        conflictMessage = nil
        isEditing = false
      }
      isSaving = false
    }
    .onChange(of: item.state) { _, state in
      if state == .claimed { isEditing = false }
    }
    .accessibilityElement(children: .contain)
  }
}
