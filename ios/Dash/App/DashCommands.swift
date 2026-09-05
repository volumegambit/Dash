import SwiftUI
import UIKit

/// The app's whole keyboard surface in one place (iPad goal Phase B, design
/// §2.1). Every shortcut Dash answers to is a case here, so the table can be
/// snapshotted by `DashCommandsTests` and so iPadOS's hold-⌘ overlay lists
/// them with real titles instead of leaving them invisible on buttons.
enum KeyboardCommand: CaseIterable, Sendable {
  case newConversation, focusSearch, previousConversation, nextConversation
  case settings, showConversations, showAgents, closeConversation
  case send, stop, focusComposer, copyLastResponse

  var shortcut: (key: KeyEquivalent, modifiers: EventModifiers) {
    switch self {
    case .newConversation: ("n", .command)
    case .focusSearch: ("f", .command)
    case .previousConversation: ("[", [.command, .shift])
    case .nextConversation: ("]", [.command, .shift])
    case .settings: (",", .command)
    case .showConversations: ("1", .command)
    case .showAgents: ("2", .command)
    case .closeConversation: ("w", .command)
    case .send: (.return, .command)
    case .stop: (.escape, [])
    case .focusComposer: ("l", .command)
    case .copyLastResponse: ("c", [.command, .shift])
    }
  }

  var title: LocalizedStringKey {
    switch self {
    case .newConversation: "New Conversation"
    case .focusSearch: "Search Conversations"
    case .previousConversation: "Previous Conversation"
    case .nextConversation: "Next Conversation"
    case .settings: "Settings…"
    case .showConversations: "Conversations"
    case .showAgents: "Agents"
    case .closeConversation: "Close Conversation"
    case .send: "Send"
    case .stop: "Stop Response"
    case .focusComposer: "Focus Message Field"
    case .copyLastResponse: "Copy Last Response"
    }
  }
}

/// What the open chat surface can do, published by `ChatView` through
/// `FocusedValues`.
///
/// Holds the live `ChatFeature` and DERIVES `canSend` / `canStop` / `canCopy`
/// from it rather than snapshotting them, and is `Equatable` on that feature's
/// identity. Both of those are load-bearing, not style:
/// `focusedSceneValue` re-applies — and thereby invalidates the scene's focus
/// entry — every time its value changes, and `ChatView`'s body re-runs on
/// every keystroke. A snapshot struct (a fresh value with fresh closures each
/// pass, uncomparable because it stores closures) therefore resigned the
/// composer's first responder mid-typing: three UI tests failed on "Expected
/// chat.composer to receive typed text", and a control run with only this
/// modifier removed turned them green again. Deriving the flags means the
/// value is genuinely unchanged for the whole life of a conversation, so it
/// is applied exactly once (see below for what that costs enablement).
///
/// `focusComposer` and `close` stay closures because they touch `ChatView`'s
/// own `@State` and `AppModel`; they are excluded from `==` and the copies
/// captured at first application keep working (`@State` storage and `AppModel`
/// both outlive the view value that captured them).
///
/// ### The tradeoff this makes, stated plainly (Task 5 review fix, Important 2)
///
/// Being `Equatable` on identity means `DashCommands.body` is GUARANTEED to
/// re-run when the focused chat changes (a different `ChatCommandActions`
/// compares unequal, so `focusedSceneValue` re-publishes) or when focus
/// moves to/from a surface with no chat open (`nil` vs. non-`nil`). What it
/// does NOT guarantee is a re-run purely because `feature.canSend` /
/// `.canCancel` / `.canCopyLastAssistantText` changed while the SAME chat
/// stays focused — that path only fires if SwiftUI wraps `Commands.body` in
/// Observation's `withObservationTracking` the way it does `View.body`,
/// which is undocumented for `Commands`. This file cannot prove that either
/// way without seeing the hold-⌘ overlay live (see `task-5-report.md`), so
/// menu enablement for `send`/`stop`/`copyLastResponse` is best described as
/// LIKELY live, not certainly live.
///
/// That is an accepted trade, not an oversight: the alternative (a
/// snapshot struct that changes identity every render, restoring
/// enablement's old refresh path) is the exact shape of the composer
/// focus-loss regression above, which is a hard, user-facing, everyday
/// bug. Stale enablement is at worst a grey-when-it-should-be-black (or
/// vice versa) menu item until the next real re-run, and every action this
/// value exposes re-guards on the live feature before doing anything
/// (`send`/`cancel` on `ChatFeature`; `copyLastResponse()` above re-checks
/// `canCopy`'s own condition at the write, closing the one path — Important
/// 1 — that could have turned staleness into data loss). With that guard in
/// place, staleness is provably cosmetic for all twelve commands, not just
/// this one.
struct ChatCommandActions: Equatable {
  let feature: ChatFeature
  let focusComposer: () -> Void
  let close: () -> Void

  @MainActor var canSend: Bool { feature.canSend }
  @MainActor var canStop: Bool { feature.canCancel }
  @MainActor var canCopy: Bool { feature.canCopyLastAssistantText }

  @MainActor func send() { Task { await feature.send() } }
  @MainActor func stop() { Task { await feature.cancel() } }

  /// Re-guards on top of `canCopy` (Task 5 review fix, Important 1) rather
  /// than trusting the menu's enabled state: `canCopy` is a cheap
  /// approximation of "the flattened text is non-empty" (see
  /// `ChatFeature.canCopyLastAssistantText`), not a byte-exact one, so this
  /// is the last line of defense against writing an empty string to
  /// `UIPasteboard.general.string` — which would silently wipe the user's
  /// system clipboard and, via Handoff, their Universal Clipboard.
  @MainActor func copyLastResponse() {
    guard
      let text = feature.lastAssistantText,
      text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    else { return }
    UIPasteboard.general.string = text
  }

  static func == (lhs: ChatCommandActions, rhs: ChatCommandActions) -> Bool {
    lhs.feature === rhs.feature
  }
}

/// What the conversation list can do, published by `ConversationListView`.
/// Same shape and the same reason as `ChatCommandActions` — see its doc
/// comment. `canCompose` deliberately leaves out the list's in-flight
/// `isComposing` guard (which is view `@State`): `startCompose()` already
/// refuses to run twice on its own, so folding a per-keystroke-ish flag into
/// this value would buy nothing and cost the stability the focus system needs.
struct ListCommandActions: Equatable {
  let feature: ConversationListFeature
  let newConversation: () -> Void
  let focusSearch: () -> Void
  let previous: () -> Void
  let next: () -> Void

  @MainActor var canCompose: Bool {
    ComposeAgentSelection.isUnavailable(
      feature.agents,
      filteredAgentID: feature.selectedAgentID,
      mutationsAllowed: feature.mutationsAllowed
    ) == false
  }

  static func == (lhs: ListCommandActions, rhs: ListCommandActions) -> Bool {
    lhs.feature === rhs.feature
  }
}

/// Navigation that belongs to the shell rather than to either column,
/// published by `RootView` — all three write `AppModel.selectedTab`, which is
/// the source of truth at both widths. Equatable on the model's identity for
/// the same focus-stability reason as `ChatCommandActions`.
struct AppCommandActions: Equatable {
  let appModel: AppModel

  @MainActor func settings() { appModel.selectedTab = .settings }
  @MainActor func showConversations() { appModel.selectedTab = .conversations }
  @MainActor func showAgents() { appModel.selectedTab = .agents }

  static func == (lhs: AppCommandActions, rhs: AppCommandActions) -> Bool {
    lhs.appModel === rhs.appModel
  }
}

private struct ChatCommandActionsKey: FocusedValueKey { typealias Value = ChatCommandActions }
private struct ListCommandActionsKey: FocusedValueKey { typealias Value = ListCommandActions }
private struct AppCommandActionsKey: FocusedValueKey { typealias Value = AppCommandActions }

extension FocusedValues {
  var chatCommands: ChatCommandActions? {
    get { self[ChatCommandActionsKey.self] }
    set { self[ChatCommandActionsKey.self] = newValue }
  }
  var listCommands: ListCommandActions? {
    get { self[ListCommandActionsKey.self] }
    set { self[ListCommandActionsKey.self] = newValue }
  }
  var appCommands: AppCommandActions? {
    get { self[AppCommandActionsKey.self] }
    set { self[AppCommandActionsKey.self] = newValue }
  }
}

/// The single `Commands` tree attached to `DashApp`'s `WindowGroup`. Routing
/// is by `@FocusedValue`, not by reaching into `AppModel`: a command is
/// enabled only while the surface that owns it is actually publishing its
/// actions, so ⌘↩ does nothing when no chat is open and ⌘N does nothing when
/// the list can't compose.
struct DashCommands: Commands {
  @FocusedValue(\.chatCommands) private var chat
  @FocusedValue(\.listCommands) private var list
  @FocusedValue(\.appCommands) private var app

  var body: some Commands {
    CommandGroup(replacing: .newItem) {
      button(.newConversation, enabled: list?.canCompose == true) { list?.newConversation() }
    }
    CommandMenu("Conversation") {
      // Greyed out rather than removed on iOS 17: `dashSearchFocused(_:)` is
      // the identity modifier there (`View.searchFocused(_:)` is iOS 18+),
      // so ⌘F would be listed, enabled, and do nothing when pressed. See
      // `dashSearchFocused(_:)`'s doc comment for why the command stays in
      // the table on every OS regardless.
      button(.focusSearch, enabled: list != nil && searchFocusIsAvailable) {
        list?.focusSearch()
      }
      button(.previousConversation, enabled: list != nil) { list?.previous() }
      button(.nextConversation, enabled: list != nil) { list?.next() }
      Divider()
      button(.send, enabled: chat?.canSend == true) { chat?.send() }
      button(.stop, enabled: chat?.canStop == true) { chat?.stop() }
      button(.focusComposer, enabled: chat != nil) { chat?.focusComposer() }
      button(.copyLastResponse, enabled: chat?.canCopy == true) { chat?.copyLastResponse() }
      button(.closeConversation, enabled: chat != nil) { chat?.close() }
    }
    // `replacing:`, not `after:` — iPadOS 26 already installs its own "Dash
    // Settings… ⌘," item in the app menu, and adding a second ⌘, alongside it
    // makes `UIMenuBuilder` throw `NSInvalidArgumentException: Replacement
    // elements contain duplicates` at launch. Replacing the group swaps the
    // system item (which points at nothing here) for the one that actually
    // opens Dash's settings.
    CommandGroup(replacing: .appSettings) {
      button(.settings, enabled: app != nil) { app?.settings() }
      button(.showConversations, enabled: app != nil) { app?.showConversations() }
      button(.showAgents, enabled: app != nil) { app?.showAgents() }
    }
  }

  /// Whether `dashSearchFocused(_:)` can actually move focus — `false` on
  /// iOS 17, where it's the identity modifier (folded-in minor 5, Task 5
  /// review). Used to grey out ⌘F there instead of leaving it enabled and
  /// silently inert.
  private var searchFocusIsAvailable: Bool {
    if #available(iOS 18.0, *) {
      true
    } else {
      false
    }
  }

  private func button(
    _ command: KeyboardCommand, enabled: Bool, action: @escaping () -> Void
  ) -> some View {
    Button(command.title, action: action)
      .keyboardShortcut(command.shortcut.key, modifiers: command.shortcut.modifiers)
      .disabled(enabled == false)
  }
}

/// Publishes `ChatCommandActions` into the scene's focused values from a
/// zero-size sibling, and — via `.equatable()` at the call site — is skipped
/// entirely while the actions compare equal, so the `focusedSceneValue`
/// modifier is never re-applied and the focus system is never disturbed. See
/// `ChatCommandActions` for why that matters.
struct ChatCommandPublisher: View, Equatable {
  let actions: ChatCommandActions

  var body: some View {
    Color.clear.allowsHitTesting(false).focusedSceneValue(\.chatCommands, actions)
  }
}

/// `ConversationListView`'s counterpart to `ChatCommandPublisher`.
struct ListCommandPublisher: View, Equatable {
  let actions: ListCommandActions

  var body: some View {
    Color.clear.allowsHitTesting(false).focusedSceneValue(\.listCommands, actions)
  }
}

/// `RootView`'s counterpart to `ChatCommandPublisher`. `actions` is `nil`
/// while signed out, which disables ⌘, ⌘1 ⌘2.
struct AppCommandPublisher: View, Equatable {
  let actions: AppCommandActions?

  var body: some View {
    Color.clear.allowsHitTesting(false).focusedSceneValue(\.appCommands, actions)
  }
}

extension View {
  /// Binds the `.searchable` field's focus so ⌘F (`KeyboardCommand
  /// .focusSearch`) can put the caret in it.
  ///
  /// `View.searchFocused(_:)` is iOS 18+ and has no iOS 17 equivalent —
  /// SwiftUI gave no way to focus a `.searchable` field programmatically
  /// before then. On iOS 17 this is the identity modifier and ⌘F therefore
  /// does nothing: the menu item stays listed and enabled (the list surface
  /// is present), it just can't move focus. That is deliberate rather than
  /// hiding the command on older systems, so the shortcut table is the same
  /// everywhere and the only difference is one no-op on a two-year-old OS.
  @ViewBuilder
  func dashSearchFocused(_ binding: FocusState<Bool>.Binding) -> some View {
    if #available(iOS 18.0, *) {
      searchFocused(binding)
    } else {
      self
    }
  }
}
