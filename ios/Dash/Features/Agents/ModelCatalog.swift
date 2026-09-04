import Foundation

/// Pure grouping/labeling over the gateway's model list (`GET /models`),
/// shared by `AgentEditorView` and the chat toolbar's `ChatModelPickerSheet`
/// (goal 2026-09-04: change model from a conversation). Unit-tested in
/// `ModelCatalogTests`.
enum ModelCatalog {
  struct Group: Equatable {
    let provider: String
    let models: [ModelDTO]
  }

  /// Providers sorted case-insensitively, models within a provider sorted by
  /// label (then value); `query` filters on label, value, or provider.
  static func grouped(_ models: [ModelDTO], query: String) -> [Group] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let filtered = models.filter { model in
      trimmed.isEmpty
        || model.label.localizedCaseInsensitiveContains(trimmed)
        || model.value.localizedCaseInsensitiveContains(trimmed)
        || model.provider.localizedCaseInsensitiveContains(trimmed)
    }
    return Dictionary(grouping: filtered, by: \.provider)
      .map { provider, models in
        Group(
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

  /// The catalog's human label for `value`, or — for a model the catalog
  /// doesn't list (an older configured id, a provider the gateway can't
  /// reach right now) — the value without its `provider/` prefix, the same
  /// fallback MC's `formatModelName` uses.
  static func label(for value: String, in models: [ModelDTO]) -> String {
    if let known = models.first(where: { $0.value == value }) { return known.label }
    guard let slash = value.firstIndex(of: "/") else { return value }
    let stripped = value[value.index(after: slash)...]
    return stripped.isEmpty ? value : String(stripped)
  }
}
