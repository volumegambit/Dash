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
          Section(group.provider) {
            ForEach(group.models, id: \.value) { model in
              row(value: model.value, label: model.label)
            }
          }
        }
      }
      .navigationTitle("Model")
      .navigationBarTitleDisplayMode(.inline)
      .searchable(text: $query, prompt: "Search models")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .accessibilityIdentifier("chat.modelPicker.cancel")
        }
      }
      .task { await agentsFeature.loadModels() }
    }
    .accessibilityIdentifier("chat.modelPicker.sheet")
  }

  private func row(value: String, label: String) -> some View {
    Button {
      Task { await select(value) }
    } label: {
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Text(label).foregroundStyle(.primary)
          if label != value {
            Text(value).font(.caption).foregroundStyle(.secondary)
          }
        }
        Spacer()
        if pendingModel == value {
          ProgressView()
        } else if value == currentModel {
          Image(systemName: "checkmark").foregroundStyle(DashTheme.accent)
        }
      }
      .contentShape(Rectangle())
    }
    .disabled(pendingModel != nil || agentsFeature.mutationsAllowed == false)
    .accessibilityLabel(label)
    .accessibilityValue(value == currentModel ? "Current model" : "")
    .accessibilityIdentifier("chat.modelPicker.row.\(value)")
  }

  private func select(_ value: String) async {
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
