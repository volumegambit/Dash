import SwiftUI

/// The three secondary surfaces of the iPad sidebar (design §1.1):
/// Conversations, Agents, and Settings. Tapping any row hands the tab
/// straight to `AppModel.selectedTab`, which `RootView`'s `sidebarPath` and
/// `isSettingsPresented` bindings project into "pop to the conversation
/// list", "push the agents list", and "present the Settings sheet"
/// respectively. Keeps the `tab.conversations` / `tab.agents` /
/// `tab.settings` identifiers and the `.isSelected` trait so
/// `DashUITestCase.selectTab` works unchanged at regular width.
struct SidebarFooterView: View {
  let selectedTab: AppTab
  let onSelect: (AppTab) -> Void

  var body: some View {
    VStack(spacing: 0) {
      Divider()
      row(
        .conversations,
        title: "Conversations",
        systemImage: "bubble.left.and.bubble.right",
        identifier: "tab.conversations"
      )
      row(.agents, title: "Agents", systemImage: "person.2", identifier: "tab.agents")
      row(.settings, title: "Settings", systemImage: "gearshape", identifier: "tab.settings")
    }
    .background(.bar)
  }

  private func row(
    _ tab: AppTab, title: LocalizedStringKey, systemImage: String, identifier: String
  ) -> some View {
    Button {
      onSelect(tab)
    } label: {
      Label(title, systemImage: systemImage)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .padding(.horizontal)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .hoverEffect(.highlight)
    .focusable()
    .foregroundStyle(selectedTab == tab ? DashTheme.accent : Color.primary)
    .accessibilityAddTraits(selectedTab == tab ? .isSelected : [])
    .accessibilityIdentifier(identifier)
  }
}

extension View {
  /// Attaches `SidebarFooterView` as a bottom safe-area inset. Applied to
  /// EACH page inside the sidebar's `NavigationStack` (see `RootView
  /// .regularNavigation`'s doc comment) rather than once on the stack
  /// itself, since a `NavigationStack`-level inset only decorates that
  /// stack's root page and disappears once anything is pushed.
  func sidebarFooter(
    selectedTab: AppTab,
    onSelect: @escaping (AppTab) -> Void
  ) -> some View {
    safeAreaInset(edge: .bottom, spacing: 0) {
      SidebarFooterView(selectedTab: selectedTab, onSelect: onSelect)
    }
  }
}
