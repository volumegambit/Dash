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
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

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

  /// Width of the sidebar column, widened at accessibility text sizes.
  ///
  /// 320 pt is the platform-conventional iPad sidebar width and is what the
  /// split view chose for itself. At `.accessibility1` and above a 320 pt
  /// column cannot show a useful conversation row — the title alone wraps to
  /// three lines — so the column grows to 420 pt, which still leaves the
  /// detail column 414 pt on an 834 pt-wide iPad, i.e. more than an iPhone
  /// gets. Below `.accessibility1` nothing changes.
  private var sidebarColumnWidth: CGFloat {
    dynamicTypeSize.isAccessibilitySize ? 420 : 320
  }

  /// The two-column regular layout (design §1.1) is an explicit two-column
  /// `HStack`, NOT a `NavigationSplitView`.
  ///
  /// `NavigationSplitView`'s sidebar column on iPadOS 18.4 positions its host
  /// view 100 pt off the LEADING edge of the window — width `column + 100`,
  /// origin `x = -100` — with a matching 100 pt leading safe-area inset that
  /// puts the visible content back in the right place. A `List` expands into
  /// safe areas by design, so `conversation.list` reported a frame starting at
  /// x = -100 and `assertFitsHorizontally` failed.
  ///
  /// That overhang is the split view's own geometry, not ours. Measured on
  /// iPad Pro 11" (M4) / iOS 18.4 at BOTH the default text size and
  /// `accessibilityXXXL`, and reproduced unchanged with: the entire sidebar
  /// replaced by a bare `List { Text("hello") }`; the column-width modifier
  /// removed; the column widened to 420 pt (the overhang grew to match, 520 pt
  /// at x = -100); no nested `NavigationStack`; no footer safe-area inset; no
  /// `.balanced` style; `columnVisibility` at `.all`; and with `.clipped()`,
  /// leading padding, a leading safe-area inset, a `GeometryReader` width
  /// clamp and an explicit safe-area cancellation applied to the content.
  /// Sixteen variants, one result. Owning the column layout is the only thing
  /// that moves it: this version measures `conversation.list` at
  /// (0, 0, 320, 1210) at the default text size and (0, 0, 420, 1210) at XXXL.
  ///
  /// What this gives up is the split view's built-in "Hide Sidebar" toggle.
  /// Design §1.1 asks for both columns visible at once and nothing in the app
  /// ever hid the sidebar programmatically (`columnVisibility` was a constant
  /// `.doubleColumn`), so that affordance is the whole of the trade.
  private var regularNavigation: some View {
    HStack(spacing: 0) {
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
      .frame(width: sidebarColumnWidth)

      Divider()

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
      .frame(maxWidth: .infinity)
    }
    .sheet(isPresented: isSettingsPresented) {
      NavigationStack { settingsRoot }
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
}
