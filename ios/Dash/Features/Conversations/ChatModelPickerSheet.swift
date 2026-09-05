import SwiftUI

/// Change the model from inside a conversation (goal 2026-09-04; MC parity
/// with `ChatModelPicker`): the gateway's models grouped by provider, the
/// agent's current one checked, tapping a row commits immediately through
/// `AgentsFeature.changeModel` — no Save step, like Claude's and ChatGPT's
/// pickers — and the sheet dismisses. Searchable, since catalogs run long.
struct ChatModelPickerSheet: View {
  let agentID: String
  let currentModel: String
  let agentsFeature: AgentsFeature
  let onChanged: (AgentsFeature.ModelChange) -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var query = ""
  @State private var pendingModel: String?

  var body: some View {
    NavigationStack {
      List {
        if agentsFeature.models.isEmpty {
          Section {
            Label(
              agentsFeature.isRefreshing ? "Loading models…" : "No models available",
              systemImage: agentsFeature.isRefreshing ? "arrow.triangle.2.circlepath" : "cpu"
            )
            .foregroundStyle(.secondary)
          }
        }
        if agentsFeature.models.contains(where: { $0.value == currentModel }) == false {
          Section("Current model") {
            row(value: currentModel, label: ModelCatalog.label(for: currentModel, in: agentsFeature.models))
          }
        }
        ForEach(ModelCatalog.grouped(agentsFeature.models, query: query), id: \.provider) { group in
          Section(ModelCatalog.providerDisplayName(group.provider)) {
            ForEach(group.models, id: \.value) { model in
              row(value: model.value, label: model.label)
            }
          }
        }
      }
      .navigationTitle("Model")
      .navigationBarTitleDisplayMode(.inline)
      .searchable(text: $query, prompt: "Search models")
      .task { await agentsFeature.loadModels() }
    }
    .accessibilityIdentifier("chat.modelPicker.sheet")
  }

  /// One model, one line (chat UI polish 2026-09-05).
  ///
  /// Every row used to carry its raw id under the label, which reads as
  /// noise for the choice being made ("anthropic/claude-haiku-4-5-20251001"
  /// is not how anyone picks a model) and, more importantly, doubled the row
  /// height: at the `.medium` detent this sheet opens in, roughly seven
  /// models were visible out of catalogs that run to several dozen, so
  /// switching meant scrolling. The id survives on the selected row alone,
  /// where it answers the one question it is actually good for — which exact
  /// build am I on — and costs one row's height instead of every row's.
  private func row(value: String, label: String) -> some View {
    let isCurrent = value == currentModel
    return Button {
      Task { await select(value) }
    } label: {
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Text(label).foregroundStyle(isCurrent ? DashTheme.accent : .primary)
          if isCurrent, label != value {
            Text(value).font(.caption).foregroundStyle(.secondary)
          }
        }
        Spacer()
        if pendingModel == value {
          ProgressView()
        } else if isCurrent {
          Image(systemName: "checkmark").foregroundStyle(DashTheme.accent)
        }
      }
      .contentShape(Rectangle())
    }
    // Only the gateway's mutation gate greys rows out. A commit in flight is
    // serialized inside `select` instead: disabling all ~40 rows for the
    // duration turned the whole sheet grey with no explanation of why, when
    // the only thing that needed to be prevented was a second commit.
    .disabled(agentsFeature.mutationsAllowed == false)
    .accessibilityLabel(label)
    .accessibilityValue(isCurrent ? "Current model" : "")
    .accessibilityIdentifier("chat.modelPicker.row.\(value)")
  }

  private func select(_ value: String) async {
    guard pendingModel == nil else { return }
    guard value != currentModel else {
      dismiss()
      return
    }
    pendingModel = value
    defer { pendingModel = nil }
    let changed = await agentsFeature.changeModel(agentID: agentID, to: value)
    guard changed, let change = agentsFeature.lastModelChange else { return }
    onChanged(change)
    dismiss()
  }
}
