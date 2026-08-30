import SwiftUI
import UIKit

enum NavigationDeviceIdiom: Sendable {
  case phone
  case pad
  case other
}

struct AdaptiveNavigationPolicy {
  static func presentation(
    idiom: NavigationDeviceIdiom,
    horizontalSizeClass: UserInterfaceSizeClass?
  ) -> NavigationPresentation {
    idiom == .pad && horizontalSizeClass == .regular ? .regular : .compact
  }

  @MainActor
  static func presentation(
    horizontalSizeClass: UserInterfaceSizeClass?
  ) -> NavigationPresentation {
    let idiom: NavigationDeviceIdiom = switch UIDevice.current.userInterfaceIdiom {
    case .phone: .phone
    case .pad: .pad
    default: .other
    }
    return presentation(idiom: idiom, horizontalSizeClass: horizontalSizeClass)
  }
}

struct RootView: View {
  static let title = "Dash"

  @Environment(AppModel.self) private var appModel
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  var body: some View {
    OfflineBanner(banner: appModel.banner) {
      if appModel.selectedProfile == nil {
        pairingNavigation
      } else if navigationPresentation == .regular {
        regularNavigation
      } else {
        compactNavigation
      }
    }
    .tint(DashTheme.accent)
    .alert("Agent update failed", isPresented: agentMutationErrorPresented) {
      Button("OK") { appModel.agentsFeature?.mutationError = nil }
    } message: {
      Text(appModel.agentsFeature?.mutationError ?? "Dash couldn't complete the update.")
    }
    .alert("Recovery update failed", isPresented: recoveryErrorPresented) {
      Button("OK") { appModel.conversationListFeature?.recoveryError = nil }
    } message: {
      Text(
        appModel.conversationListFeature?.recoveryError
          ?? "The saved message remains available."
      )
    }
  }

  private var agentMutationErrorPresented: Binding<Bool> {
    Binding(
      get: {
        appModel.selectedTab == .agents && appModel.agentsFeature?.mutationError != nil
      },
      set: { isPresented in
        if isPresented == false {
          appModel.agentsFeature?.mutationError = nil
        }
      }
    )
  }

  private var recoveryErrorPresented: Binding<Bool> {
    Binding(
      get: {
        appModel.selectedTab == .conversations
          && appModel.conversationListFeature?.recoveryError != nil
      },
      set: { isPresented in
        if isPresented == false {
          appModel.conversationListFeature?.recoveryError = nil
        }
      }
    )
  }

  private var pairingNavigation: some View {
    AccountNavigationView(appModel: appModel)
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
      AgentsListView(presentation: navigationPresentation)
        .environment(feature)
        .id(ObjectIdentifier(feature))
    } else {
      FeatureSlotView(title: "Agents", systemImage: "person.2")
    }
  }

  @ViewBuilder
  private var conversationListRoot: some View {
    if let feature = appModel.conversationListFeature {
      ConversationListView(presentation: navigationPresentation)
        .environment(feature)
        .id(ObjectIdentifier(feature))
    } else {
      FeatureSlotView(
        title: "Conversations",
        systemImage: "bubble.left.and.bubble.right"
      )
    }
  }

  private var navigationPresentation: NavigationPresentation {
    AdaptiveNavigationPolicy.presentation(horizontalSizeClass: horizontalSizeClass)
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
    case .recovery(let id):
      if let feature = appModel.conversationListFeature,
        let recovery = feature.recoverablePendingSends.first(where: {
          $0.conversationID == id
        })
      {
        PendingSendRecoveryView(
          recovery: recovery,
          presentation: navigationPresentation
        )
          .environment(feature)
          .id(recovery.pendingSend.turnID)
      } else {
        ContentUnavailableView(
          "Recovered message unavailable",
          systemImage: "tray",
          description: Text("Return to Conversations to see messages that still need recovery.")
        )
        .navigationTitle("Message Recovery")
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
    .task(
      id: ChatHostTaskID(
        conversationID: conversation.id,
        appGeneration: appModel.chatHostGeneration
      )
    ) {
      feature = nil
      didFailToLoad = false
      let loaded = await appModel.makeChatFeature(conversation)
      guard Task.isCancelled == false else { return }
      feature = loaded
      didFailToLoad = loaded == nil
    }
    .onChange(of: appModel.connectionState) { _, connection in
      feature?.setConnection(connection)
      if connection == .online, let feature {
        Task { await feature.connectionDidBecomeOnline() }
      }
    }
  }
}

private struct ChatHostTaskID: Equatable {
  let conversationID: String
  let appGeneration: UInt64
}

/// Signed-out entry point: `SignInView` until the Clerk account session has a
/// live token, then `GatewayPickerView` to choose which enrolled gateway to
/// connect to. Owns the signed-in/signed-out toggle locally (rather than in
/// `AppModel`) since it mirrors `AccountSession`'s own actor-isolated cache,
/// not app-wide navigation state that other features need to observe.
@MainActor
private struct AccountNavigationView: View {
  @Bindable var appModel: AppModel
  @State private var isSignedIn: Bool?
  @State private var pickerViewModel: GatewayPickerViewModel?

  var body: some View {
    NavigationStack {
      Group {
        if isSignedIn == true, let pickerViewModel {
          GatewayPickerView(viewModel: pickerViewModel)
        } else if isSignedIn == false {
          SignInView(signIn: signIn)
        } else {
          ProgressView()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
    }
    .task { await refreshSignInState() }
    .task(id: pickerViewModel.map(ObjectIdentifier.init)) {
      guard let pickerViewModel else { return }
      await pickerViewModel.load()
    }
  }

  private func signIn() async throws {
    try await appModel.signInToAccount()
    isSignedIn = true
    pickerViewModel = makePickerViewModel()
  }

  private func refreshSignInState() async {
    let signedIn = await appModel.isAccountSignedIn()
    isSignedIn = signedIn
    pickerViewModel = signedIn ? makePickerViewModel() : nil
  }

  private func makePickerViewModel() -> GatewayPickerViewModel {
    appModel.makeGatewayPickerViewModel {
      isSignedIn = false
      pickerViewModel = nil
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
