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
          .accessibilityIdentifier(AppTab.conversations.accessibilityID)
      }
      .tag(AppTab.conversations)

      NavigationStack(path: $appModel.agentPath) {
        agentsListRoot
          .navigationDestination(for: AgentRoute.self) { route in
            agentDestination(route)
          }
      }
      .tabItem {
        Label("Agents", systemImage: "person.2")
          .accessibilityIdentifier(AppTab.agents.accessibilityID)
      }
      .tag(AppTab.agents)

      NavigationStack {
        settingsRoot
      }
      .tabItem {
        Label("Settings", systemImage: "gearshape")
          .accessibilityIdentifier(AppTab.settings.accessibilityID)
      }
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
          .accessibilityIdentifier(tab.accessibilityID)
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
          settingsRoot
        }
      }
    }
  }

  @ViewBuilder
  private var settingsRoot: some View {
    if let feature = appModel.settingsFeature {
      SettingsView()
        .environment(feature)
        .id(ObjectIdentifier(feature))
    } else {
      FeatureSlotView(title: "Settings", systemImage: "gearshape")
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
    case .transcript(let id):
      if let conversation = conversationSummary(id: id) {
        ChatFeatureHostView(appModel: appModel, conversation: conversation)
      } else {
        ContentUnavailableView(
          "Conversation unavailable",
          systemImage: "bubble.left.and.bubble.right",
          description: Text("Return to Conversations and choose another chat.")
        )
        .navigationTitle("Conversation")
      }
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

  private func conversationSummary(id: String) -> ConversationSummaryDTO? {
    appModel.conversationListFeature?.conversations.first { $0.id == id }?.summary
      ?? appModel.snapshot?.conversations.first { $0.id == id }?.summary
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
private struct ChatFeatureHostView: View {
  @Bindable var appModel: AppModel
  let conversation: ConversationSummaryDTO

  @State private var feature: ChatFeature?
  @State private var didFailToLoad = false

  var body: some View {
    Group {
      if let feature {
        ChatView()
          .environment(feature)
          .id(ObjectIdentifier(feature))
      } else if didFailToLoad {
        ContentUnavailableView(
          "Chat unavailable",
          systemImage: "exclamationmark.bubble",
          description: Text("Check this gateway's connection and try again.")
        )
        .navigationTitle(conversation.title)
      } else {
        ProgressView("Opening conversation")
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .navigationTitle(conversation.title)
      }
    }
    .task(id: conversation.id) {
      guard feature == nil else { return }
      feature = await appModel.makeChatFeature(conversation)
      didFailToLoad = feature == nil
    }
    .onChange(of: appModel.connectionState) { _, connection in
      feature?.setConnection(connection)
      if connection == .online, let feature {
        Task { await feature.retryConnection() }
      }
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
  fileprivate var accessibilityID: String {
    "tab.\(rawValue)"
  }

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
