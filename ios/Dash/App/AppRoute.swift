import Foundation

enum AppTab: String, CaseIterable, Hashable, Identifiable, Sendable {
  case conversations
  case agents
  case settings

  var id: Self { self }
}

enum AppRoute: Equatable, Sendable {
  case connect
  case paired(tab: AppTab)
}

enum PairingRoute: Hashable, Sendable {
  case scanner
  case manual
}

enum ConversationRoute: Hashable, Sendable {
  case transcript(String)
  case recovery(String)
  case newConversation
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

enum NavigationPresentation: Sendable {
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
