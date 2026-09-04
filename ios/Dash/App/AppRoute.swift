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
