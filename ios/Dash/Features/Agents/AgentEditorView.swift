import SwiftUI

struct AgentEditorView: View {
  let original: RegisteredAgentDTO?

  @Environment(AppModel.self) private var appModel
  @Environment(AgentsFeature.self) private var feature
  @Environment(\.dismiss) private var dismiss
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  @State private var draft: AgentEditorDraft
  @State private var modelSearch = ""
  @State private var isSaving = false

  init(original: RegisteredAgentDTO?) {
    self.original = original
    _draft = State(
      initialValue: AgentEditorDraft(
        name: original?.name ?? "",
        model: original?.config.model ?? "",
        systemPrompt: original?.config.systemPrompt ?? ""
      )
    )
  }

  var body: some View {
    Form {
      Section("Agent") {
        TextField("Name", text: $draft.name)
          .textInputAutocapitalization(.words)
          .disabled(original != nil)
          .accessibilityIdentifier("agent.editor.name")
        if original != nil {
          Text("Agent names are read-only after creation.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        TextField("Model", text: $draft.model)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .accessibilityIdentifier("agent.editor.model")
      }

      if let configuredMissingModel {
        Section("Configured model") {
          modelButton(
            title: "Configured model: \(configuredMissingModel)",
            value: configuredMissingModel
          )
        }
      }

      ForEach(groupedModels, id: \.provider) { group in
        Section(group.provider) {
          ForEach(group.models, id: \.value) { model in
            modelButton(title: model.label, value: model.value)
          }
        }
      }

      Section("System prompt") {
        TextField("Instructions for this agent", text: $draft.systemPrompt, axis: .vertical)
          .lineLimit(5...12)
          .accessibilityIdentifier("agent.editor.prompt")
      }

      Section {
        Button {
          Task { await save() }
        } label: {
          HStack {
            Spacer()
            if isSaving {
              ProgressView()
            } else {
              Text(original == nil ? "Create agent" : "Save changes")
            }
            Spacer()
          }
          .frame(minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .disabled(feature.mutationsAllowed == false || isSaving)
        .accessibilityIdentifier("agent.editor.save")
      }
    }
    .navigationTitle(original == nil ? "Create agent" : "Edit agent")
    .searchable(text: $modelSearch, prompt: "Search models")
    .task { await feature.loadModels() }
  }

  private var configuredMissingModel: String? {
    guard
      let configured = original?.config.model,
      feature.models.contains(where: { $0.value == configured }) == false
    else { return nil }
    return configured
  }

  private var groupedModels: [(provider: String, models: [ModelDTO])] {
    let query = modelSearch.trimmingCharacters(in: .whitespacesAndNewlines)
    let filtered = feature.models.filter { model in
      query.isEmpty
        || model.label.localizedCaseInsensitiveContains(query)
        || model.value.localizedCaseInsensitiveContains(query)
        || model.provider.localizedCaseInsensitiveContains(query)
    }
    return Dictionary(grouping: filtered, by: \.provider)
      .map { provider, models in
        (
          provider: provider,
          models: models.sorted {
            let order = $0.label.localizedCaseInsensitiveCompare($1.label)
            if order == .orderedSame { return $0.value < $1.value }
            return order == .orderedAscending
          }
        )
      }
      .sorted { $0.provider.localizedCaseInsensitiveCompare($1.provider) == .orderedAscending }
  }

  private func modelButton(title: String, value: String) -> some View {
    Button {
      draft.model = value
    } label: {
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .foregroundStyle(.primary)
          if title != value {
            Text(value)
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
        Spacer()
        if draft.model == value {
          Image(systemName: "checkmark")
            .foregroundStyle(DashTheme.accent)
            .accessibilityLabel("Selected")
        }
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  private func save() async {
    isSaving = true
    defer { isSaving = false }
    if let original {
      await feature.update(id: original.id, original: original, draft: draft)
    } else {
      await feature.create(draft)
    }
    guard feature.mutationError == nil else { return }
    if horizontalSizeClass == .regular, let id = feature.savedAgentID {
      appModel.openAgent(.detail(id), presentation: .regular)
    } else {
      dismiss()
    }
  }
}
