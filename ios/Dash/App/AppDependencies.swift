import Foundation
import SwiftData

enum AppDependencyError: Error, Equatable, Sendable {
  case missingSecrets(profileID: UUID)
  case pairingActivationFailed
}

typealias PairedProfileHandler =
  @MainActor @Sendable (ConnectionProfileSnapshot) async throws -> Void

struct PairingFeatureFactory: Sendable {
  let verifier: any PairingVerifying
  let installer: any PairingProfileInstalling
  let makeScanner: @Sendable () -> any QRScanning

  init(
    verifier: any PairingVerifying,
    installer: any PairingProfileInstalling,
    makeScanner: @escaping @Sendable () -> any QRScanning = { UnavailableQRScanner() }
  ) {
    self.verifier = verifier
    self.installer = installer
    self.makeScanner = makeScanner
  }

  @MainActor
  func make(onPaired: @escaping PairedProfileHandler) -> PairingFeature {
    PairingFeature(
      verifier: verifier,
      installer: installer,
      scanner: makeScanner(),
      onPaired: onPaired
    )
  }

  static let unavailable = PairingFeatureFactory(
    verifier: UnavailablePairingVerifier(),
    installer: UnavailablePairingInstaller()
  )
}

struct AppDependencies: Sendable {
  let clock: any AppClock
  let loadProfile: @Sendable () async throws -> ConnectionProfileSnapshot?
  let makeSyncEngine: @Sendable (ConnectionProfileSnapshot) async throws -> any AppSyncing
  let verifyProfile: @Sendable (ConnectionProfileSnapshot) async throws -> Void
  let rememberProfile: @MainActor @Sendable (ConnectionProfileSnapshot) -> Void
  let deleteProfileSecrets: @Sendable (ConnectionProfileSnapshot) async throws -> Void
  let clearProfileData: @Sendable (ConnectionProfileSnapshot) async throws -> Void
  let forgetProfileSelection: @MainActor @Sendable (ConnectionProfileSnapshot) -> Void
  let makeConversationListFeature:
    @MainActor @Sendable (ConnectionProfileSnapshot) -> ConversationListFeature?
  let makeAgentsFeature: @MainActor @Sendable (ConnectionProfileSnapshot) -> AgentsFeature?
  let pairingFeatureFactory: PairingFeatureFactory

  init(
    clock: any AppClock,
    loadProfile: @escaping @Sendable () async throws -> ConnectionProfileSnapshot?,
    makeSyncEngine: @escaping @Sendable (
      ConnectionProfileSnapshot
    ) async throws -> any AppSyncing,
    verifyProfile: @escaping @Sendable (ConnectionProfileSnapshot) async throws -> Void = { _ in },
    rememberProfile: @escaping @MainActor @Sendable (ConnectionProfileSnapshot) -> Void = { _ in },
    deleteProfileSecrets: @escaping @Sendable (ConnectionProfileSnapshot) async throws -> Void = {
      _ in
    },
    clearProfileData: @escaping @Sendable (ConnectionProfileSnapshot) async throws -> Void = {
      _ in
    },
    forgetProfileSelection: @escaping @MainActor @Sendable (ConnectionProfileSnapshot) -> Void = {
      _ in
    },
    makeConversationListFeature: @escaping @MainActor @Sendable (
      ConnectionProfileSnapshot
    ) -> ConversationListFeature? = { _ in nil },
    makeAgentsFeature: @escaping @MainActor @Sendable (
      ConnectionProfileSnapshot
    ) -> AgentsFeature? = { _ in nil },
    pairingFeatureFactory: PairingFeatureFactory = .unavailable
  ) {
    self.clock = clock
    self.loadProfile = loadProfile
    self.makeSyncEngine = makeSyncEngine
    self.verifyProfile = verifyProfile
    self.rememberProfile = rememberProfile
    self.deleteProfileSecrets = deleteProfileSecrets
    self.clearProfileData = clearProfileData
    self.forgetProfileSelection = forgetProfileSelection
    self.makeConversationListFeature = makeConversationListFeature
    self.makeAgentsFeature = makeAgentsFeature
    self.pairingFeatureFactory = pairingFeatureFactory
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
    let pendingConversationCreates = PendingConversationCreateStore()
    let clock = SystemAppClock()
    let activeGatewayKey = "app.dash.ios.active-gateway-id"

    let makeTransport:
      @Sendable (
        ConnectionEndpoint,
        ConnectionSecrets
      ) -> HTTPTransport = { endpoint, secrets in
        HTTPTransport(endpoint: endpoint, secrets: secrets, clock: clock)
      }
    let makeCancellableTransport:
      @Sendable (
        ConnectionEndpoint,
        ConnectionSecrets
      ) -> HTTPTransport = { endpoint, secrets in
        HTTPTransport(
          endpoint: endpoint,
          secrets: secrets,
          session: URLSession(configuration: .default),
          clock: clock
        )
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
    let pairingMetadata = PersistencePairingMetadataStore(store: store)
    let profileVerifier = GatewayProfileVerifier { endpoint, secrets in
      makeAPI(makeCancellableTransport(endpoint, secrets))
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
      verifyProfile: { profile in
        guard let secrets = try await keychain.load(for: profile.id) else {
          throw AppDependencyError.missingSecrets(profileID: profile.id)
        }
        try await profileVerifier.verify(profile: profile, secrets: secrets)
      },
      rememberProfile: { profile in
        UserDefaults.standard.set(profile.gatewayID, forKey: activeGatewayKey)
      },
      deleteProfileSecrets: { profile in
        try await keychain.delete(for: profile.id)
      },
      clearProfileData: { profile in
        try await store.clearGateway(gatewayID: profile.gatewayID)
        await pendingConversationCreates.clear(gatewayID: profile.gatewayID)
      },
      forgetProfileSelection: { _ in
        UserDefaults.standard.removeObject(forKey: activeGatewayKey)
      },
      makeConversationListFeature: { profile in
        let service = LiveConversationListService(
          gatewayID: profile.gatewayID,
          store: store,
          pendingCreates: pendingConversationCreates,
          makeAPI: {
            guard let secrets = try await keychain.load(for: profile.id) else {
              throw AppDependencyError.missingSecrets(profileID: profile.id)
            }
            let endpoint = ConnectionEndpoint(profile: profile.profile, secrets: secrets)
            return makeAPI(makeCancellableTransport(endpoint, secrets))
          }
        )
        return ConversationListFeature(gatewayID: profile.gatewayID, service: service)
      },
      makeAgentsFeature: { profile in
        let makeProfileAPI: @Sendable () async throws -> GatewayAPI = {
          guard let secrets = try await keychain.load(for: profile.id) else {
            throw AppDependencyError.missingSecrets(profileID: profile.id)
          }
          let endpoint = ConnectionEndpoint(profile: profile.profile, secrets: secrets)
          return makeAPI(makeCancellableTransport(endpoint, secrets))
        }
        let conversationService = LiveConversationListService(
          gatewayID: profile.gatewayID,
          store: store,
          pendingCreates: pendingConversationCreates,
          makeAPI: makeProfileAPI
        )
        let service = LiveAgentsService(
          gatewayID: profile.gatewayID,
          store: store,
          conversations: conversationService,
          makeAPI: makeProfileAPI
        )
        return AgentsFeature(gatewayID: profile.gatewayID, service: service)
      },
      pairingFeatureFactory: PairingFeatureFactory(
        verifier: PairingVerifier(
          makeGateway: { endpoint, secrets in
            makeAPI(makeTransport(endpoint, secrets))
          },
          makeChat: makeChat
        ),
        installer: PairingProfileInstaller(keychain: keychain, metadata: pairingMetadata),
        makeScanner: { QRScannerService() }
      )
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
