import Foundation
import SwiftData

enum AppDependencyError: Error, Equatable, Sendable {
  case missingSecrets(profileID: UUID)
}

struct AppDependencies: Sendable {
  let clock: any AppClock
  let loadProfile: @Sendable () async throws -> ConnectionProfileSnapshot?
  let makeSyncEngine: @Sendable (ConnectionProfileSnapshot) async throws -> any AppSyncing
  let rememberProfile: @MainActor @Sendable (ConnectionProfileSnapshot) -> Void
  let deleteProfileSecrets: @Sendable (ConnectionProfileSnapshot) async throws -> Void
  let clearProfileData: @Sendable (ConnectionProfileSnapshot) async throws -> Void
  let forgetProfileSelection: @MainActor @Sendable (ConnectionProfileSnapshot) -> Void

  init(
    clock: any AppClock,
    loadProfile: @escaping @Sendable () async throws -> ConnectionProfileSnapshot?,
    makeSyncEngine: @escaping @Sendable (
      ConnectionProfileSnapshot
    ) async throws -> any AppSyncing,
    rememberProfile: @escaping @MainActor @Sendable (ConnectionProfileSnapshot) -> Void = { _ in },
    deleteProfileSecrets: @escaping @Sendable (ConnectionProfileSnapshot) async throws -> Void = {
      _ in
    },
    clearProfileData: @escaping @Sendable (ConnectionProfileSnapshot) async throws -> Void = {
      _ in
    },
    forgetProfileSelection: @escaping @MainActor @Sendable (ConnectionProfileSnapshot) -> Void = {
      _ in
    }
  ) {
    self.clock = clock
    self.loadProfile = loadProfile
    self.makeSyncEngine = makeSyncEngine
    self.rememberProfile = rememberProfile
    self.deleteProfileSecrets = deleteProfileSecrets
    self.clearProfileData = clearProfileData
    self.forgetProfileSelection = forgetProfileSelection
  }

  @MainActor
  static func live() throws -> AppDependencies {
    let schema = Schema([
      GatewayProfileRecord.self,
      ConversationRecord.self,
      MessageRecord.self,
      AgentRecord.self,
      DraftRecord.self,
      ReplayCursorRecord.self,
    ])
    let container = try ModelContainer(
      for: schema,
      configurations: [ModelConfiguration(schema: schema)]
    )
    let store = PersistenceStore(modelContainer: container)
    let keychain = SystemKeychainStore()
    let clock = SystemAppClock()
    let activeGatewayKey = "app.dash.ios.active-gateway-id"

    let makeTransport:
      @Sendable (
        ConnectionEndpoint,
        ConnectionSecrets
      ) -> HTTPTransport = { endpoint, secrets in
        HTTPTransport(endpoint: endpoint, secrets: secrets, clock: clock)
      }
    let makeAPI: @Sendable (HTTPTransport) -> GatewayAPI = { transport in
      GatewayAPI(transport: transport)
    }
    let makeInvalidations:
      @Sendable (
        ConnectionEndpoint,
        ConnectionSecrets
      ) -> SSEInvalidationSource = { endpoint, secrets in
        SSEInvalidationSource(client: SSEClient(endpoint: endpoint, secrets: secrets))
      }
    let makeChat: @Sendable (ConnectionEndpoint) -> ChatConnection = { endpoint in
      ChatConnection(endpoint: endpoint, clock: clock)
    }
    let makeReachability: @Sendable () -> NetworkReachability = {
      NetworkReachability()
    }

    return AppDependencies(
      clock: clock,
      loadProfile: {
        guard let gatewayID = UserDefaults.standard.string(forKey: activeGatewayKey) else {
          return nil
        }
        return try await store.profile(gatewayID: gatewayID)
      },
      makeSyncEngine: { profile in
        guard let secrets = try await keychain.load(for: profile.id) else {
          throw AppDependencyError.missingSecrets(profileID: profile.id)
        }
        let endpoint = ConnectionEndpoint(profile: profile.profile, secrets: secrets)
        let transport = makeTransport(endpoint, secrets)
        return ConversationSyncEngine(
          gatewayID: profile.gatewayID,
          store: store,
          api: makeAPI(transport),
          invalidations: makeInvalidations(endpoint, secrets),
          chat: makeChat(endpoint),
          reachability: makeReachability(),
          clock: clock
        )
      },
      rememberProfile: { profile in
        UserDefaults.standard.set(profile.gatewayID, forKey: activeGatewayKey)
      },
      deleteProfileSecrets: { profile in
        try await keychain.delete(for: profile.id)
      },
      clearProfileData: { profile in
        try await store.clearGateway(gatewayID: profile.gatewayID)
      },
      forgetProfileSelection: { _ in
        UserDefaults.standard.removeObject(forKey: activeGatewayKey)
      }
    )
  }
}

struct AppDependenciesFactory {
  let make: @MainActor () throws -> AppDependencies

  init(_ make: @escaping @MainActor () throws -> AppDependencies) {
    self.make = make
  }

  @MainActor
  static var live: AppDependenciesFactory {
    AppDependenciesFactory { try AppDependencies.live() }
  }
}
