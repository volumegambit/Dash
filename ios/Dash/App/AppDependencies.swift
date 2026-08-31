import Foundation
import SwiftData
import UIKit

enum AppDependencyError: Error, Equatable, Sendable {
  case missingSecrets(profileID: UUID)
  case pairingActivationFailed
}

typealias PairedProfileHandler =
  @MainActor @Sendable (ConnectionProfileSnapshot) async throws -> Void

struct PairingFeatureFactory: Sendable {
  let verifier: any PairingVerifying
  let installer: any PairingProfileInstalling

  init(
    verifier: any PairingVerifying,
    installer: any PairingProfileInstalling
  ) {
    self.verifier = verifier
    self.installer = installer
  }

  @MainActor
  func make(onPaired: @escaping PairedProfileHandler) -> PairingFeature {
    PairingFeature(
      verifier: verifier,
      installer: installer,
      onPaired: onPaired
    )
  }

  static let unavailable = PairingFeatureFactory(
    verifier: UnavailablePairingVerifier(),
    installer: UnavailablePairingInstaller()
  )
}

/// A `WebAuthPresenting` conformer that always fails immediately, used only
/// to give `AccountFeatureFactory.unavailable` a harmless placeholder
/// `AccountSession` (mirrors `UnavailablePairingVerifier`/
/// `UnavailablePairingInstaller`).
private struct UnavailableWebAuthPresenter: WebAuthPresenting {
  func authenticate(url: URL, callbackScheme: String) async throws -> URL {
    throw AccountSessionError.exchangeFailed
  }
}

/// Bundles the account sign-in surface (`AccountSession`, `ControlPlaneClient`)
/// with the SAME verify/install pipeline pairing uses, mirroring
/// `PairingFeatureFactory`'s shape so `AppModel` can construct
/// `AccountConnectFeature` per connect attempt without reaching into
/// `AppDependencies.live()`'s private closures.
struct AccountFeatureFactory: Sendable {
  let session: AccountSession
  let client: ControlPlaneClient
  let verifier: any PairingVerifying
  let installer: any PairingProfileInstalling
  let signer: SignerIdentity
  /// The camera scanner Task 6's "Approve a device" flow presents. A stored
  /// instance (mirroring `verifier`/`installer` above) rather than a
  /// per-call factory closure, since a real `QRScannerService` is cheap to
  /// hold and UI tests substitute a scripted fake here the same way they do
  /// for `verifier`/`installer`.
  let scanner: any QRScanning
  let makeDeviceLabel: @Sendable () -> String

  init(
    session: AccountSession,
    client: ControlPlaneClient,
    verifier: any PairingVerifying,
    installer: any PairingProfileInstalling,
    signer: SignerIdentity,
    scanner: any QRScanning = QRScannerService(),
    makeDeviceLabel: @escaping @Sendable () -> String = AccountFeatureFactory.defaultDeviceLabel
  ) {
    self.session = session
    self.client = client
    self.verifier = verifier
    self.installer = installer
    self.signer = signer
    self.scanner = scanner
    self.makeDeviceLabel = makeDeviceLabel
  }

  var isSignedIn: Bool {
    get async { await session.isSignedIn }
  }

  func signIn() async throws {
    try await session.signIn()
  }

  func signOut() async {
    await session.signOut()
  }

  func listGateways() async throws -> [GatewayInfoDTO] {
    try await client.listGateways()
  }

  /// Best-effort: swallows failures since callers use this for opportunistic
  /// cleanup (e.g. on account sign-out), never as a precondition for it.
  func revokePairing(gatewayId: String, pairingId: String) async {
    try? await client.revokePairing(gatewayId: gatewayId, pairingId: pairingId)
  }

  @MainActor
  func makeConnect(
    onGrantMinted: @escaping @MainActor @Sendable (String, String) -> Void = { _, _ in },
    onConnected: @escaping PairedProfileHandler
  ) -> AccountConnectFeature {
    AccountConnectFeature(
      client: client,
      verifier: verifier,
      installer: installer,
      signer: signer,
      deviceLabel: makeDeviceLabel(),
      onGrantMinted: onGrantMinted,
      onConnected: onConnected
    )
  }

  /// Builds a fresh `ApproveDeviceViewModel` for one scan-to-approve attempt
  /// (Task 6). `resolveSignerId` implements "register-then-decide": most of
  /// the time `signer.signerId()` already holds a value from the best-effort
  /// registration `makeConnect`'s `connect(to:)` performs on every
  /// successful gateway connect, but a device that reaches this screen
  /// despite that registration having failed (offline, CP blip) registers
  /// now, on demand, using this same signer key — rather than showing a dead
  /// end that tells the user to reconnect a gateway they're already
  /// connected to.
  @MainActor
  func makeApproveDeviceViewModel() -> ApproveDeviceViewModel {
    ApproveDeviceViewModel(
      scanner: scanner,
      fetchApproval: { id in try await self.client.fetchApproval(id: id) },
      resolveSignerId: {
        if let existing = try await self.signer.signerId() {
          return existing
        }
        let publicKey = try await self.signer.publicKeyB64()
        let signerId = try await self.client.registerSigner(
          publicKey: publicKey,
          label: self.makeDeviceLabel()
        )
        try await self.signer.persistSignerId(signerId)
        return signerId
      },
      sign: { approvalId, pairingId, decision in
        try await self.signer.sign(
          approvalId: approvalId,
          pairingId: pairingId,
          decision: decision
        )
      },
      postDecision: { approvalId, decision, signerId, signature in
        try await self.client.postDecision(
          approvalId: approvalId,
          decision: decision,
          signerId: signerId,
          signature: signature
        )
      }
    )
  }

  /// `UIDevice.current.name` is the MODEL name (e.g. "iPhone"), not the
  /// user's custom device name, on iOS 16+ without the
  /// `com.apple.developer.device-information.user-assigned-device-name`
  /// entitlement — a literal `"iPhone · \(UIDevice.current.name)"` would
  /// read as the redundant "iPhone · iPhone". Append a short, stable-per-app
  /// suffix instead so MC's device list can tell two same-model phones
  /// apart.
  static func defaultDeviceLabel() -> String {
    let name = UIDevice.current.name
    let suffix = UIDevice.current.identifierForVendor.map { String($0.uuidString.suffix(4)) }
    guard let suffix else { return name }
    return "\(name) (\(suffix))"
  }

  static let unavailable: AccountFeatureFactory = {
    let config = AccountAuthConfig(
      frontendAPIHost: "unavailable.invalid",
      clientID: "unavailable",
      controlPlaneURL: URL(string: "https://unavailable.invalid")!,
      redirectURI: "dash://oauth-callback"
    )
    let session = AccountSession(config: config, presenter: UnavailableWebAuthPresenter())
    return AccountFeatureFactory(
      session: session,
      client: ControlPlaneClient(config: config, tokens: session),
      verifier: UnavailablePairingVerifier(),
      installer: UnavailablePairingInstaller(),
      signer: SignerIdentity(keychain: SystemKeychainStore())
    )
  }()
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
  let makeChatFeature:
    @MainActor @Sendable (
      ConnectionProfileSnapshot,
      ConversationSummaryDTO
    ) async -> ChatFeature?
  let pairingFeatureFactory: PairingFeatureFactory
  let accountFeatureFactory: AccountFeatureFactory

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
    makeChatFeature: @escaping @MainActor @Sendable (
      ConnectionProfileSnapshot,
      ConversationSummaryDTO
    ) async -> ChatFeature? = { _, _ in nil },
    pairingFeatureFactory: PairingFeatureFactory = .unavailable,
    accountFeatureFactory: AccountFeatureFactory = .unavailable
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
    self.makeChatFeature = makeChatFeature
    self.pairingFeatureFactory = pairingFeatureFactory
    self.accountFeatureFactory = accountFeatureFactory
  }

  @MainActor
  static func live() throws -> AppDependencies {
    let schema = PersistenceSchema.make()
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
        HTTPTransport(
          endpoint: endpoint,
          secrets: secrets,
          session: GatewayURLSessionFactory.make(profile: endpoint.profile),
          clock: clock
        )
      }
    let makeCancellableTransport:
      @Sendable (
        ConnectionEndpoint,
        ConnectionSecrets
      ) -> HTTPTransport = { endpoint, secrets in
        HTTPTransport(
          endpoint: endpoint,
          secrets: secrets,
          session: GatewayURLSessionFactory.make(
            profile: endpoint.profile,
            configuration: .default
          ),
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
        SSEInvalidationSource(
          client: SSEClient(
            endpoint: endpoint,
            secrets: secrets,
            session: GatewayURLSessionFactory.make(profile: endpoint.profile)
          )
        )
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
    // Shared with `accountFeatureFactory` below: the account sign-in connect
    // pipeline reuses the SAME hardened verify+install machinery QR/manual
    // pairing uses, so a gateway reached via account sign-in and one reached
    // via a scanned code land on identical, metadata-reusing profiles.
    let pairingVerifier = PairingVerifier(
      makeGateway: { endpoint, secrets in
        makeAPI(makeTransport(endpoint, secrets))
      },
      makeChat: makeChat
    )
    let pairingInstaller = PairingProfileInstaller(keychain: keychain, metadata: pairingMetadata)
    let accountAuthConfig = try AccountAuthConfig.fromBundle()
    let accountSession = AccountSession(
      config: accountAuthConfig,
      presenter: SystemWebAuthPresenter()
    )
    let controlPlaneClient = ControlPlaneClient(config: accountAuthConfig, tokens: accountSession)
    // Shares `keychain` (the same `SystemKeychainStore` backing paired
    // connections' secrets) — see `SignerIdentity`'s doc comment for why a
    // dedicated fixed namespace on that same store can't collide with a real
    // connection's `profileID`-keyed entry.
    let signerIdentity = SignerIdentity(keychain: keychain)

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
        return ConversationListFeature(
          gatewayID: profile.gatewayID,
          service: service,
          recoveryService: LiveConversationRecoveryService(
            gatewayID: profile.gatewayID,
            store: store
          )
        )
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
      makeChatFeature: { profile, conversation in
        guard let secrets = try? await keychain.load(for: profile.id) else {
          return nil
        }
        let endpoint = ConnectionEndpoint(profile: profile.profile, secrets: secrets)
        let persistence = LiveChatPersistence(store: store)
        let synchronizer = LiveChatSynchronizer(
          gatewayID: profile.gatewayID,
          store: store,
          makeAPI: {
            guard let currentSecrets = try await keychain.load(for: profile.id) else {
              throw GatewayError.unauthorized
            }
            let currentEndpoint = ConnectionEndpoint(
              profile: profile.profile,
              secrets: currentSecrets
            )
            return makeAPI(makeCancellableTransport(currentEndpoint, currentSecrets))
          }
        )
        return ChatFeature(
          gatewayID: profile.gatewayID,
          conversation: conversation,
          persistence: persistence,
          synchronizer: synchronizer,
          transport: LiveChatFeatureTransport(makeConnection: { makeChat(endpoint) }),
          clock: clock
        )
      },
      pairingFeatureFactory: PairingFeatureFactory(
        verifier: pairingVerifier,
        installer: pairingInstaller
      ),
      accountFeatureFactory: AccountFeatureFactory(
        session: accountSession,
        client: controlPlaneClient,
        verifier: pairingVerifier,
        installer: pairingInstaller,
        signer: signerIdentity
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
