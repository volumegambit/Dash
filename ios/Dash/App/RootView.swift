import SwiftUI

struct RootView: View {
  static let title = "Dash"

  @Environment(AppModel.self) private var appModel
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  var body: some View {
    OfflineBanner(banner: appModel.banner) {
      if appModel.selectedProfile == nil {
        pairingNavigation
      } else if horizontalSizeClass == .regular {
        regularNavigation
      } else {
        compactNavigation
      }
    }
    .tint(DashTheme.accent)
  }

  private var pairingNavigation: some View {
    @Bindable var appModel = appModel
    return NavigationStack(path: $appModel.pairingPath) {
      FeatureSlotView(title: "Connect", systemImage: "link")
        .navigationDestination(for: PairingRoute.self) { route in
          switch route {
          case .scanner:
            FeatureSlotView(title: "Scan code", systemImage: "qrcode.viewfinder")
          case .manual:
            FeatureSlotView(title: "Enter manually", systemImage: "keyboard")
          }
        }
    }
  }

  private var compactNavigation: some View {
    @Bindable var appModel = appModel
    return TabView(selection: $appModel.selectedTab) {
      NavigationStack(path: $appModel.conversationPath) {
        FeatureSlotView(
          title: "Conversations",
          systemImage: "bubble.left.and.bubble.right"
        )
        .navigationDestination(for: ConversationRoute.self) { route in
          conversationDestination(route)
        }
      }
      .tabItem {
        Label("Conversations", systemImage: "bubble.left.and.bubble.right")
      }
      .tag(AppTab.conversations)

      NavigationStack(path: $appModel.agentPath) {
        FeatureSlotView(title: "Agents", systemImage: "person.2")
          .navigationDestination(for: AgentRoute.self) { route in
            agentDestination(route)
          }
      }
      .tabItem { Label("Agents", systemImage: "person.2") }
      .tag(AppTab.agents)

      NavigationStack {
        FeatureSlotView(title: "Settings", systemImage: "gearshape")
      }
      .tabItem { Label("Settings", systemImage: "gearshape") }
      .tag(AppTab.settings)
    }
  }

  private var regularNavigation: some View {
    @Bindable var appModel = appModel
    let selection = Binding<AppTab?>(
      get: { appModel.selectedTab },
      set: { tab in
        if let tab { appModel.selectedTab = tab }
      }
    )
    return NavigationSplitView {
      List(AppTab.allCases, selection: selection) { tab in
        Label(tab.title, systemImage: tab.systemImage)
          .frame(minWidth: 44, minHeight: 44)
          .tag(tab)
      }
      .navigationTitle(Self.title)
    } detail: {
      NavigationStack {
        switch appModel.selectedTab {
        case .conversations:
          if let selection = appModel.splitConversationSelection {
            conversationDestination(selection)
          } else {
            FeatureSlotView(
              title: "Conversations",
              systemImage: "bubble.left.and.bubble.right"
            )
          }
        case .agents:
          FeatureSlotView(title: "Agents", systemImage: "person.2")
        case .settings:
          FeatureSlotView(title: "Settings", systemImage: "gearshape")
        }
      }
    }
  }

  @ViewBuilder
  private func conversationDestination(_ route: ConversationRoute) -> some View {
    switch route {
    case .transcript:
      FeatureSlotView(title: "Conversation", systemImage: "bubble.left.and.bubble.right")
    case .newConversation:
      FeatureSlotView(title: "New conversation", systemImage: "square.and.pencil")
    }
  }

  @ViewBuilder
  private func agentDestination(_ route: AgentRoute) -> some View {
    switch route {
    case .detail:
      FeatureSlotView(title: "Agent", systemImage: "person.crop.circle")
    case .create:
      FeatureSlotView(title: "Create agent", systemImage: "person.badge.plus")
    case .edit:
      FeatureSlotView(title: "Edit agent", systemImage: "person.crop.circle.badge.checkmark")
    case .startChat:
      FeatureSlotView(title: "New conversation", systemImage: "bubble.left.and.text.bubble.right")
    }
  }
}

private struct FeatureSlotView: View {
  let title: String
  let systemImage: String

  var body: some View {
    ContentUnavailableView(title, systemImage: systemImage)
      .navigationTitle(title)
  }
}

extension AppTab {
  fileprivate var title: LocalizedStringKey {
    switch self {
    case .conversations: "Conversations"
    case .agents: "Agents"
    case .settings: "Settings"
    }
  }

  fileprivate var systemImage: String {
    switch self {
    case .conversations: "bubble.left.and.bubble.right"
    case .agents: "person.2"
    case .settings: "gearshape"
    }
  }
}
