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
    PairingNavigationView(appModel: appModel)
  }

  private var compactNavigation: some View {
    @Bindable var appModel = appModel
    return TabView(selection: $appModel.selectedTab) {
      NavigationStack(path: $appModel.conversationPath) {
        conversationListRoot
          .navigationDestination(for: ConversationRoute.self) { route in
            conversationDestination(route)
          }
      }
      .tabItem {
        Label("Conversations", systemImage: "bubble.left.and.bubble.right")
      }
      .tag(AppTab.conversations)

      NavigationStack(path: $appModel.agentPath) {
        agentsListRoot
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
    } content: {
      NavigationStack {
        switch appModel.selectedTab {
        case .conversations:
          conversationListRoot
        case .agents:
          agentsListRoot
        case .settings:
          FeatureSlotView(title: "Settings", systemImage: "gearshape")
        }
      }
      .navigationDestination(for: ConversationRoute.self) { route in
        conversationDestination(route)
      }
      .navigationDestination(for: AgentRoute.self) { route in
        agentDestination(route)
      }
    } detail: {
      NavigationStack {
        switch appModel.selectedTab {
        case .conversations:
          if let selection = appModel.splitConversationSelection {
            conversationDestination(selection)
          } else {
            ContentUnavailableView(
              "Select a conversation",
              systemImage: "bubble.left.and.bubble.right"
            )
          }
        case .agents:
          if let selection = appModel.splitAgentSelection {
            agentDestination(selection)
          } else {
            ContentUnavailableView("Select an agent", systemImage: "person.crop.circle")
          }
        case .settings:
          FeatureSlotView(title: "Settings", systemImage: "gearshape")
        }
      }
    }
  }

  @ViewBuilder
  private var agentsListRoot: some View {
    if let feature = appModel.agentsFeature {
      AgentsListView()
        .environment(feature)
        .id(ObjectIdentifier(feature))
    } else {
      FeatureSlotView(title: "Agents", systemImage: "person.2")
    }
  }

  @ViewBuilder
  private var conversationListRoot: some View {
    if let feature = appModel.conversationListFeature {
      ConversationListView()
        .environment(feature)
        .id(ObjectIdentifier(feature))
    } else {
      FeatureSlotView(
        title: "Conversations",
        systemImage: "bubble.left.and.bubble.right"
      )
    }
  }

  @ViewBuilder
  private func conversationDestination(_ route: ConversationRoute) -> some View {
    switch route {
    case .transcript:
      FeatureSlotView(title: "Conversation", systemImage: "bubble.left.and.bubble.right")
    case .newConversation:
      if let feature = appModel.conversationListFeature {
        NewConversationView()
          .environment(feature)
          .id(ObjectIdentifier(feature))
      } else {
        FeatureSlotView(title: "New conversation", systemImage: "square.and.pencil")
      }
    }
  }

  @ViewBuilder
  private func agentDestination(_ route: AgentRoute) -> some View {
    if let feature = appModel.agentsFeature {
      Group {
        switch route {
        case .detail(let id):
          AgentDetailView(agentID: id)
        case .create:
          AgentEditorView(original: nil)
        case .edit(let id):
          if let agent = feature.agents.first(where: { $0.id == id }) {
            AgentEditorView(original: agent)
          } else {
            ContentUnavailableView(
              "Agent unavailable",
              systemImage: "person.crop.circle.badge.questionmark"
            )
          }
        case .startChat(let id):
          AgentDetailView(agentID: id)
        }
      }
      .environment(feature)
      .id(route)
    } else {
      FeatureSlotView(title: "Agent", systemImage: "person.crop.circle")
    }
  }
}

@MainActor
private struct PairingNavigationView: View {
  @Bindable var appModel: AppModel
  @State private var feature: PairingFeature

  init(appModel: AppModel) {
    self.appModel = appModel
    _feature = State(initialValue: appModel.makePairingFeature())
  }

  var body: some View {
    NavigationStack(path: $appModel.pairingPath) {
      ConnectView()
        .navigationDestination(for: PairingRoute.self) { route in
          switch route {
          case .scanner:
            QRScannerView()
          case .manual:
            ManualEntryView()
          }
        }
    }
    .environment(feature)
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
