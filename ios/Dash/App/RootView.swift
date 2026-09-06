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

  @State private var columnVisibility: NavigationSplitViewVisibility = .doubleColumn
  /// Covers the async gap between tapping the empty detail's "New
  /// conversation" button and `openConversation` actually navigating — the
  /// same window `ConversationListView.isComposing` guards for the list's own
  /// compose button. See `composeFromEmptyDetail()`.
  @State private var isComposingFromDetail = false

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
    // iPad goal Phase B: the shell's own commands (⌘, ⌘1 ⌘2). All three
    // write `selectedTab`, which is the source of truth at BOTH widths — on
    // the two-column layout `sidebarPath` turns `.agents` into a push and
    // `isSettingsPresented` turns `.settings` into a sheet, so these need no
    // presentation-specific branch of their own.
    .background { AppCommandPublisher(actions: appCommands).equatable() }
    .onChange(of: navigationPresentation) { _, presentation in
      appModel.reconcileNavigation(for: presentation)
    }
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

  /// `nil` — which DISABLES ⌘, ⌘1 ⌘2 rather than leaving them listed and
  /// inert — while signed out, since `pairingNavigation` has no tabs at all.
  /// Publishing them there would let ⌘, quietly set `selectedTab = .settings`
  /// behind the sign-in screen, so the first thing the user saw after pairing
  /// would be the Settings sheet they never asked for.
  private var appCommands: AppCommandActions? {
    appModel.selectedProfile == nil ? nil : AppCommandActions(appModel: appModel)
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

  /// iPad two-column layout (design §1.1): the sidebar's local push stack —
  /// `[.agents]` while Agents is showing, empty (root = the conversation
  /// list) otherwise. `SidebarFooterView`'s Conversations row sets
  /// `selectedTab = .conversations` directly, which this binding's `get`
  /// turns into an empty path — i.e. popping the stack to its root — for
  /// free, no separate "pop" case needed.
  private var sidebarPath: Binding<[SidebarRoute]> {
    Binding(
      get: { appModel.selectedTab == .agents ? [.agents] : [] },
      set: { path in
        appModel.selectedTab = path.contains(.agents) ? .agents : .conversations
      }
    )
  }

  /// Settings is a sheet on the two-column layout, not a third column or a
  /// pushed route — presented whenever `selectedTab == .settings`, and
  /// dismissing it (swipe-down or the sheet's own dismiss) sends the tab
  /// back to Conversations rather than leaving `selectedTab` stuck on a tab
  /// with no on-screen representation.
  private var isSettingsPresented: Binding<Bool> {
    Binding(
      get: { appModel.selectedTab == .settings },
      set: { presented in if presented == false { appModel.selectedTab = .conversations } }
    )
  }

  private var regularNavigation: some View {
    NavigationSplitView(columnVisibility: $columnVisibility) {
      // `SidebarFooterView` is attached via `.sidebarFooter(...)` to EACH
      // page inside the stack (the conversation-list root AND the pushed
      // Agents destination) rather than once on the `NavigationStack`
      // itself: each pushed page becomes its own full-bleed UIKit
      // navigation-controller page, so a `.safeAreaInset` (or a VStack
      // sibling — tried first, same result) attached to the stack
      // container only ever decorates its ROOT page and disappears the
      // moment anything is pushed — confirmed via the accessibility
      // hierarchy dump showing zero `tab.*` elements once Agents was
      // pushed. Attaching the inset per-page keeps the footer's identity
      // (and the `tab.*` identifiers `DashUITestCase.selectTab` looks for)
      // present on every page of the sidebar stack.
      NavigationStack(path: sidebarPath) {
        conversationListRoot
          .sidebarFooter(selectedTab: appModel.selectedTab) { tab in
            appModel.selectedTab = tab
          }
          .navigationDestination(for: SidebarRoute.self) { route in
            switch route {
            case .agents:
              agentsListRoot
                .sidebarFooter(selectedTab: appModel.selectedTab) { tab in
                  appModel.selectedTab = tab
                }
            }
          }
      }
      .navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 400)
    } detail: {
      NavigationStack {
        switch appModel.selectedTab {
        case .agents:
          if let selection = appModel.splitAgentSelection {
            agentDestination(selection)
          } else {
            ContentUnavailableView("Select an agent", systemImage: "person.crop.circle")
          }
        case .conversations, .settings:
          if let selection = appModel.splitConversationSelection {
            conversationDestination(selection)
          } else {
            emptyDetail
          }
        }
      }
    }
    .navigationSplitViewStyle(.balanced)
    .sheet(isPresented: isSettingsPresented) {
      // Presentation audit (iPad goal Phase D, Task 11 / design §1.1):
      // Settings at regular width is a form sheet, not the phone's
      // full-height column blown up. `FormSheetSizing` is a no-op on iOS 17.
      NavigationStack { settingsRoot }
        .modifier(FormSheetSizing())
    }
  }

  private var emptyDetail: some View {
    ContentUnavailableView {
      Label("Select a conversation", systemImage: "bubble.left.and.bubble.right")
    } actions: {
      Button("New conversation") {
        Task { await composeFromEmptyDetail() }
      }
      .buttonStyle(.borderedProminent)
      .frame(minHeight: 44)
      .disabled(isComposingFromDetail || composeUnavailable)
      .accessibilityIdentifier("detail.newConversation")
      .accessibilityHint(composeUnavailableHint)
    }
  }

  /// The empty detail's compose button answers to the SAME availability
  /// predicate as the conversation list's own compose button
  /// (`ComposeAgentSelection.isUnavailable`), rather than being permanently
  /// enabled and silently doing nothing when `composeConversation()` can find
  /// no agent to compose under. `nil` feature means the list hasn't been
  /// built yet, which is likewise not composable.
  private var composeUnavailable: Bool {
    guard let feature = appModel.conversationListFeature else { return true }
    return ComposeAgentSelection.isUnavailable(
      feature.agents,
      filteredAgentID: feature.selectedAgentID,
      mutationsAllowed: feature.mutationsAllowed
    )
  }

  private var composeUnavailableHint: String {
    guard let feature = appModel.conversationListFeature else { return "" }
    return ComposeAgentSelection.unavailableHint(
      feature.agents,
      filteredAgentID: feature.selectedAgentID,
      mutationsAllowed: feature.mutationsAllowed
    )
  }

  /// The two-column layout's empty-detail compose entry point (iPad goal
  /// Phase A, Task 2): delegates agent resolution and conversation
  /// creation to `ConversationListFeature.composeConversation()` — the same
  /// path `ConversationListView.startCompose()` uses — then owns
  /// navigation itself, since the feature deliberately holds no `AppModel`
  /// reference.
  private func composeFromEmptyDetail() async {
    guard isComposingFromDetail == false else { return }
    // Armed BEFORE the first `await`: `composeConversation()` suspends twice
    // (`lastUsedAgentID()`, then `create(agentID:)`), and a second tap landing
    // inside that window would otherwise pass this guard and run a concurrent
    // create with interleaved `pendingCreateRequestID` / `pendingCreateAgentID`
    // mutation. Mirrors `ConversationListView.startCompose()`.
    isComposingFromDetail = true
    defer { isComposingFromDetail = false }
    guard let feature = appModel.conversationListFeature,
      let id = await feature.composeConversation()
    else { return }
    appModel.openConversation(id, presentation: .regular)
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
      if let conversation = appModel.conversationSummary(id: id) {
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
}
