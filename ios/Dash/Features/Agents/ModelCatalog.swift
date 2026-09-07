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

  /// Vendor-cased provider names for the ids whose display form is not just
  /// their id capitalized. Only those: the bundled catalogs also ship
  /// `anthropic` and `google`, which `providerDisplayName`'s fallback
  /// already renders correctly, and duplicating them here would invite the
  /// map and the fallback to drift.
  private static let providerDisplayNames: [String: String] = [
    "openai": "OpenAI",
    "moonshotai": "Moonshot AI",
    "openrouter": "OpenRouter",
  ]

  /// The provider id as a person would write it — section headers in the
  /// model picker showed raw ids ("anthropic", "moonshotai"), which read as
  /// config keys rather than as the vendor names the user is choosing
  /// between.
  ///
  /// This cannot be a closed mapping: only five provider ids are reserved
  /// (`RESERVED_PROVIDER_IDS` in packages/plugins/src/loader.ts) and plugins
  /// register the rest at runtime, so an unknown id has to degrade to
  /// something presentable. Capitalizing the first character is the one
  /// transformation that is safe for every shape an id might take —
  /// notably it leaves dotted ids (`z.ai` → `Z.ai`) intact, where
  /// word-splitting or title-casing would mangle them.
  static func providerDisplayName(_ provider: String) -> String {
    if let known = providerDisplayNames[provider.lowercased()] { return known }
    guard let first = provider.first else { return provider }
    return first.uppercased() + provider.dropFirst()
  }

  /// Providers sorted case-insensitively by display name, models within a
  /// provider sorted by label (then value); `query` filters on label, value,
  /// provider id, or provider display name.
  static func grouped(_ models: [ModelDTO], query: String) -> [Group] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let filtered = models.filter { model in
      trimmed.isEmpty
        || model.label.localizedCaseInsensitiveContains(trimmed)
        || model.value.localizedCaseInsensitiveContains(trimmed)
        || model.provider.localizedCaseInsensitiveContains(trimmed)
        // The header on screen says "Moonshot AI"; searching the words the
        // user just read must not come back empty because the id is
        // `moonshotai`.
        || providerDisplayName(model.provider).localizedCaseInsensitiveContains(trimmed)
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
      .sorted {
        providerDisplayName($0.provider)
          .localizedCaseInsensitiveCompare(providerDisplayName($1.provider)) == .orderedAscending
      }
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
