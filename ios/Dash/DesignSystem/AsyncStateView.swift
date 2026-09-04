import SwiftUI

enum AsyncViewState<Value> {
  case loading
  case empty(title: LocalizedStringKey, systemImage: String)
  case failed(message: LocalizedStringKey)
  case loaded(Value)
}

struct AsyncStateView<Value, LoadedContent: View>: View {
  let state: AsyncViewState<Value>
  let retry: @MainActor () -> Void
  @ViewBuilder let loadedContent: (Value) -> LoadedContent

  var body: some View {
    switch state {
    case .loading:
      ProgressView("Loading")
        .accessibilityLabel("Loading")
    case .empty(let title, let systemImage):
      ContentUnavailableView(title, systemImage: systemImage)
    case .failed(let message):
      ContentUnavailableView {
        Label("Unable to load", systemImage: "exclamationmark.triangle")
      } description: {
        Text(message)
      } actions: {
        Button("Try again", action: retry)
          .frame(minWidth: 44, minHeight: 44)
      }
    case .loaded(let value):
      loadedContent(value)
    }
  }
}
