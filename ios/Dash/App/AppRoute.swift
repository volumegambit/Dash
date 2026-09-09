import Foundation

enum AppTab: String, CaseIterable, Hashable, Identifiable, Sendable {
  case conversations
  case agents
  case settings

  var id: Self { self }
}

enum AppRoute: Equatable, Sendable {
  /// No gateway selected yet: shows `SignInView` (signed out) or
  /// `GatewayPickerView` (signed in, choosing a gateway to connect to).
  /// Named `connect` for source compatibility with existing call sites; QR/
  /// paste/manual pairing entry, this route's original UI, was retired in
  /// Task 7 of the iOS account sign-in plan.
  case connect
  case paired(tab: AppTab)
}

/// Multi-window (design §3.2): the restorable identity of a chat-only
/// window opened from "Open in New Window". `Codable` because SwiftUI
/// persists a `WindowGroup(id:for:)` presented value across scene
/// restoration; `gatewayID` rides along with the conversation id so a
/// restored window that comes back pointed at a DIFFERENT gateway than the
/// one now signed in shows "Conversation unavailable" rather than a
/// same-id conversation belonging to somebody else's gateway.
struct ConversationWindowValue: Codable, Hashable, Sendable {
  let gatewayID: String
  let conversationID: String
}

enum ConversationRoute: Hashable, Sendable {
  case transcript(String)
  case recovery(String)
}

enum AgentRoute: Hashable, Sendable {
  case detail(String)
  case create
  case edit(String)
  case startChat(String)

  func selectsAgent(_ agentID: String) -> Bool {
    switch self {
    case .detail(let id), .edit(let id), .startChat(let id):
      id == agentID
    case .create:
      false
    }
  }
}

/// iPad two-column layout (design §1.1): what the sidebar column can push
/// on top of the conversation list. Settings is a sheet, not a route.
enum SidebarRoute: Hashable, Sendable {
  case agents
}

enum NavigationPresentation: Equatable, Sendable {
  case compact
  case regular
}

enum AppBanner: Equatable, Sendable {
  case offline
  case gatewayOffline
  case rateLimited(retryAt: Date)
  case repairRequired
  case updateRequired
  case failed(String)
}
