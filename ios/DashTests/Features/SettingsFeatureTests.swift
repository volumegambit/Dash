import Foundation
import Testing

@testable import Dash

@Suite("Gateway settings")
@MainActor
struct SettingsFeatureTests {
  @Test("safe display values expose identity mode health and last sync without endpoint data")
  func safeDisplayValues() {
    let lastSync = Date(timeIntervalSince1970: 1_234)
    let feature = makeFeature(
      publicKey: "abcdef-public-key-uvwxyz",
      connection: .online,
      lastSuccessfulSyncAt: lastSync
    )

    #expect(feature.identity.gatewayId == "gateway-settings")
    #expect(feature.identity.publicKey == "abcdef-public-key-uvwxyz")
    #expect(feature.gatewayLabel == "Tokyo Gateway")
    #expect(feature.publicKeyFingerprint == "abcdef…uvwxyz")
    #expect(feature.mode == .lan)
    #expect(feature.modeText == "LAN")
    #expect(feature.connection == .online)
    #expect(feature.connectionText == "Online")
    #expect(feature.lastSuccessfulSyncAt == lastSync)
    #expect(feature.displayValues.contains("private.example") == false)
    #expect(feature.displayValues.contains("management-secret") == false)
    #expect(feature.displayValues.contains("chat-secret") == false)
  }

  @Test("short public keys are never echoed as a fingerprint")
  func shortPublicKeyIsMasked() {
    let feature = makeFeature(publicKey: "short")

    #expect(feature.publicKeyFingerprint == "Unavailable")
    #expect(feature.displayValues.contains("short") == false)
  }

  @Test("snapshot consumption keeps settings health and last sync current")
  func consumesSnapshot() {
    let feature = makeFeature(connection: .connecting)
    let instant = Date(timeIntervalSince1970: 2_345)

    feature.consume(
      SyncSnapshot(
        connection: .rateLimited(retryAt: Date(timeIntervalSince1970: 2_400)),
        conversations: [],
        agents: [],
        lastSuccessfulSyncAt: instant
      )
    )

    #expect(feature.connection == .rateLimited(retryAt: Date(timeIntervalSince1970: 2_400)))
    #expect(feature.connectionText == "Rate limited")
    #expect(feature.lastSuccessfulSyncAt == instant)
  }

  @Test("reconnect invokes the authoritative app action exactly once")
  func reconnectOnce() async {
    let actions = SettingsActionRecorder()
    let feature = makeFeature(actions: actions)

    await feature.reconnect()

    #expect(await actions.calls == [.reconnect])
    #expect(feature.isReconnecting == false)
    #expect(feature.error == nil)
    #expect(feature.canReconnect)
  }

  @Test("reconnect is unavailable during transitional rate-limit and repair states")
  func reconnectUnavailableStates() async {
    let states: [GatewayConnectionState] = [
      .connecting,
      .reconnecting(attempt: 1, retryAt: Date(timeIntervalSince1970: 10)),
      .rateLimited(retryAt: Date(timeIntervalSince1970: 10)),
      .repairRequired,
      .updateRequired,
    ]

    for state in states {
      let actions = SettingsActionRecorder()
      let feature = makeFeature(connection: state, actions: actions)

      #expect(feature.canReconnect == false)
      await feature.reconnect()
      #expect(await actions.calls.isEmpty)
    }
  }

  @Test("reconnect progress keeps a meaningful accessibility title")
  func reconnectProgressTitle() {
    let feature = makeFeature()
    #expect(feature.reconnectButtonTitle == "Reconnect")

    feature.isReconnecting = true

    #expect(feature.reconnectButtonTitle == "Reconnecting")
  }

  @Test("authorization loss uses account-era copy, never retired re-pairing instructions")
  func authorizationLossUsesAccountEraCopy() async {
    // QR/paste/manual pairing entry is retired, so "re-pair this device" names
    // a screen the app no longer has. Every unauthorized-shaped reconnect
    // failure must instead point at the two paths that still exist.
    let unauthorizedFailures: [@MainActor @Sendable () async throws -> Void] = [
      { throw AppDependencyError.missingSecrets(profileID: UUID()) },
      { throw GatewayProfileVerificationError.identityMismatch },
      { throw GatewayError.unauthorized },
    ]

    for failure in unauthorizedFailures {
      let feature = SettingsFeature(
        profile: profile(),
        connection: .offline,
        lastSuccessfulSyncAt: nil,
        reconnectAction: failure,
        disconnectAction: {}
      )

      await feature.reconnect()

      #expect(
        feature.error
          == "Sign in again from the gateway list, or Disconnect & Forget this gateway, then try again."
      )
      #expect(feature.error?.contains("Re-pair") == false)
    }

    #expect(makeFeature(connection: .repairRequired).connectionText == "Session no longer authorized")
  }

  @Test("disconnect does nothing before confirmation")
  func disconnectRequiresConfirmation() async {
    let actions = SettingsActionRecorder()
    let feature = makeFeature(actions: actions)

    await feature.disconnectAndForget(confirmed: false)

    #expect(await actions.calls.isEmpty)
    #expect(feature.isForgetting == false)
  }

  @Test("confirmed disconnect cancels an in-flight reconnect before forgetting secrets")
  func disconnectSupersedesReconnect() async {
    let actions = CancellableSettingsActions()
    let feature = SettingsFeature(
      profile: profile(),
      connection: .offline,
      lastSuccessfulSyncAt: nil,
      reconnectAction: { try await actions.reconnect() },
      disconnectAction: { await actions.disconnect() }
    )

    let reconnect = Task { await feature.reconnect() }
    await actions.waitUntilReconnecting()

    await feature.disconnectAndForget(confirmed: true)
    await actions.releaseReconnect()
    await reconnect.value

    #expect(await actions.calls == [.reconnectStarted, .reconnectCancelled, .disconnect])
    #expect(feature.isReconnecting == false)
    #expect(feature.isForgetting == false)
  }

  @Test("AppModel teardown cancels a settings verifier before deleting Keychain secrets")
  func appModelTeardownCancelsReconnectBeforeKeychain() async throws {
    let lifecycle = CancellableSettingsLifecycle()
    let profile = profile()
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { _ in SettingsSyncEngine() },
        verifyProfile: { _ in try await lifecycle.verify() },
        deleteProfileSecrets: { _ in await lifecycle.deleteSecrets() }
      )
    )
    await model.start()
    await model.consume(
      SyncSnapshot(
        connection: .offline,
        conversations: [],
        agents: [],
        lastSuccessfulSyncAt: nil
      )
    )
    let feature = try #require(model.settingsFeature)
    let reconnect = Task { await feature.reconnect() }
    await lifecycle.waitUntilVerifying()

    try await model.disconnectAndForget()
    await lifecycle.releaseVerification()
    await reconnect.value

    #expect(await lifecycle.events == [.verifyStarted, .verifyCancelled, .deleteSecrets])
    #expect(model.selectedProfile == nil)
  }

  @Test("Keychain deletion failure keeps settings visible with retry guidance")
  func keychainFailure() async {
    let actions = SettingsActionRecorder(disconnectError: .keychain)
    let feature = makeFeature(actions: actions)

    await feature.disconnectAndForget(confirmed: true)

    #expect(await actions.calls == [.disconnect])
    #expect(feature.error == "Dash couldn't remove this gateway from Keychain. Try again.")
    #expect(feature.isForgetting == false)
  }

  @Test("cache purge failure reports local cleanup after the connection is removed")
  func localCleanupFailure() async {
    let actions = SettingsActionRecorder(disconnectError: .localCleanup)
    let feature = makeFeature(actions: actions)

    await feature.disconnectAndForget(confirmed: true)

    #expect(await actions.calls == [.disconnect])
    #expect(
      feature.error
        == "The connection was removed, but Dash couldn't remove all cached gateway data."
    )
  }

  @Test("AppModel reconnect verifies identity before one authoritative bootstrap")
  func appModelReconnectOrder() async throws {
    let events = SettingsLifecycleRecorder()
    let engine = SettingsSyncEngine(events: events)
    let profile = profile()
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { _ in engine },
        verifyProfile: { value in
          #expect(value == profile)
          await events.record(.verify)
        }
      )
    )
    await model.start()
    await model.consume(
      SyncSnapshot(
        connection: .offline,
        conversations: [],
        agents: [],
        lastSuccessfulSyncAt: nil
      )
    )
    await events.clear()
    let feature = try #require(model.settingsFeature)

    await feature.reconnect()

    #expect(await events.values == [.verify, .bootstrap])
    #expect(feature.error == nil)
  }

  @Test("AppModel reconnect never leaves an unexpected verifier failure connecting forever")
  func appModelReconnectUnexpectedGatewayFailureIsOffline() async throws {
    let profile = profile()
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { _ in SettingsSyncEngine() },
        verifyProfile: { _ in throw GatewayError.notFound }
      )
    )
    await model.start()
    await model.consume(
      SyncSnapshot(
        connection: .offline,
        conversations: [],
        agents: [],
        lastSuccessfulSyncAt: nil
      )
    )
    let feature = try #require(model.settingsFeature)

    await feature.reconnect()

    #expect(model.connectionState == .offline)
    #expect(model.banner == .offline)
    #expect(feature.connection == .offline)
  }

  @Test("AppModel keeps cached settings after Keychain failure")
  func appModelKeychainFailureKeepsProfile() async throws {
    let profile = profile()
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { _ in SettingsSyncEngine() },
        deleteProfileSecrets: { _ in throw SettingsTestError.failed }
      )
    )
    await model.start()
    let feature = try #require(model.settingsFeature)

    await feature.disconnectAndForget(confirmed: true)

    #expect(model.selectedProfile == profile)
    #expect(model.settingsFeature === feature)
    #expect(model.connectionState == .repairRequired)
    #expect(feature.error == "Dash couldn't remove this gateway from Keychain. Try again.")
  }

  @Test("AppModel clears an unusable profile after cache purge failure")
  func appModelCacheFailureClearsProfile() async throws {
    let profile = profile()
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { _ in SettingsSyncEngine() },
        clearProfileData: { _ in throw SettingsTestError.failed }
      )
    )
    await model.start()
    let feature = try #require(model.settingsFeature)

    await feature.disconnectAndForget(confirmed: true)

    #expect(model.selectedProfile == nil)
    #expect(model.settingsFeature == nil)
    #expect(
      feature.error
        == "The connection was removed, but Dash couldn't remove all cached gateway data."
    )
  }

  @Test("profile verifier checks health capabilities and pinned identity before shutdown")
  func profileVerifierSuccess() async throws {
    let gateway = SettingsGatewayStub(
      identity: GatewayIdentityDTO(
        gatewayId: "gateway-settings",
        publicKey: "abcdef-public-key-uvwxyz"
      )
    )
    let verifier = GatewayProfileVerifier { _, _ in gateway }

    try await verifier.verify(profile: profile(), secrets: secrets())

    #expect(await gateway.calls == [.health, .identity, .shutdown])
  }

  @Test("profile verifier rejects missing capabilities and always shuts down")
  func profileVerifierCapabilityFailure() async {
    let gateway = SettingsGatewayStub(capabilities: [.conversationSyncV1])
    let verifier = GatewayProfileVerifier { _, _ in gateway }

    await #expect(throws: GatewayError.capabilityRequired) {
      try await verifier.verify(profile: profile(), secrets: secrets())
    }

    #expect(await gateway.calls == [.health, .shutdown])
  }

  @Test("profile verifier rejects an unhealthy gateway before identity")
  func profileVerifierHealthFailure() async {
    let gateway = SettingsGatewayStub(status: "degraded")
    let verifier = GatewayProfileVerifier { _, _ in gateway }

    await #expect(throws: GatewayError.gatewayOffline) {
      try await verifier.verify(profile: profile(), secrets: secrets())
    }

    #expect(await gateway.calls == [.health, .shutdown])
  }

  @Test("profile verifier rejects a newer mobile API before identity")
  func profileVerifierAPIVersionFailure() async {
    let gateway = SettingsGatewayStub(apiVersion: 2)
    let verifier = GatewayProfileVerifier { _, _ in gateway }

    await #expect(throws: GatewayError.updateRequired) {
      try await verifier.verify(profile: profile(), secrets: secrets())
    }

    #expect(await gateway.calls == [.health, .shutdown])
  }

  @Test("profile verifier rejects a changed gateway identity")
  func profileVerifierIdentityFailure() async {
    let gateway = SettingsGatewayStub(
      identity: GatewayIdentityDTO(gatewayId: "gateway-other", publicKey: "public-key-other")
    )
    let verifier = GatewayProfileVerifier { _, _ in gateway }

    await #expect(throws: GatewayProfileVerificationError.identityMismatch) {
      try await verifier.verify(profile: profile(), secrets: secrets())
    }

    #expect(await gateway.calls == [.health, .identity, .shutdown])
  }

  @Test("profile verifier rejects an empty stored public-key pin")
  func profileVerifierEmptyPinFailure() async {
    let gateway = SettingsGatewayStub(
      identity: GatewayIdentityDTO(gatewayId: "gateway-settings", publicKey: "")
    )
    let verifier = GatewayProfileVerifier { _, _ in gateway }

    await #expect(throws: GatewayProfileVerificationError.identityMismatch) {
      try await verifier.verify(profile: profile(publicKey: ""), secrets: secrets())
    }

    #expect(await gateway.calls.isEmpty)
  }

  @Test("profile verifier stops before identity when cancelled after health")
  func profileVerifierCancellationAfterHealth() async {
    let gateway = CancellationIgnoringSettingsGateway()
    let verifier = GatewayProfileVerifier { _, _ in gateway }
    let operation = Task {
      try await verifier.verify(profile: profile(), secrets: secrets())
    }
    await gateway.waitUntilCheckingHealth()

    operation.cancel()
    await gateway.releaseHealth()

    do {
      try await operation.value
      Issue.record("Expected profile verification to preserve cancellation")
    } catch {
      #expect(error is CancellationError)
    }
    #expect(await gateway.calls == [.health, .shutdown])
  }

  private func makeFeature(
    publicKey: String = "abcdef-public-key-uvwxyz",
    connection: GatewayConnectionState = .offline,
    lastSuccessfulSyncAt: Date? = nil,
    actions: SettingsActionRecorder = SettingsActionRecorder()
  ) -> SettingsFeature {
    SettingsFeature(
      profile: profile(publicKey: publicKey),
      connection: connection,
      lastSuccessfulSyncAt: lastSuccessfulSyncAt,
      reconnectAction: { await actions.reconnect() },
      disconnectAction: { try await actions.disconnect() }
    )
  }

  private func profile(publicKey: String = "abcdef-public-key-uvwxyz")
    -> ConnectionProfileSnapshot
  {
    ConnectionProfileSnapshot(
      gatewayID: "gateway-settings",
      profile: ConnectionProfile(
        id: UUID(uuidString: "00000000-0000-0000-0000-000000000014")!,
        gatewayId: "gateway-settings",
        publicKey: publicKey,
        label: "Tokyo Gateway",
        host: "private.example",
        managementPort: 9_400,
        chatPort: 9_400,
        secure: true,
        mode: .lan,
        tlsCertificateSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        createdAt: Date(timeIntervalSince1970: 1_000),
        lastSuccessfulSyncAt: nil
      )
    )
  }

  private func secrets() -> ConnectionSecrets {
    ConnectionSecrets(
      managementToken: "mobile-secret",
      chatToken: "mobile-secret",
      relayCredential: nil
    )
  }
}

private actor SettingsActionRecorder {
  enum Call: Equatable, Sendable {
    case reconnect
    case disconnect
  }

  private(set) var calls: [Call] = []
  private let disconnectError: SettingsDisconnectError?

  init(disconnectError: SettingsDisconnectError? = nil) {
    self.disconnectError = disconnectError
  }

  func reconnect() {
    calls.append(.reconnect)
  }

  func disconnect() throws {
    calls.append(.disconnect)
    if let disconnectError { throw disconnectError }
  }
}

private actor CancellableSettingsActions {
  enum Call: Equatable, Sendable {
    case reconnectStarted
    case reconnectCancelled
    case disconnect
  }

  private let gate = TestGate()
  private(set) var calls: [Call] = []

  func reconnect() async throws {
    calls.append(.reconnectStarted)
    try await withTaskCancellationHandler {
      await gate.wait()
      try Task.checkCancellation()
    } onCancel: {
      Task { await self.cancelReconnect() }
    }
  }

  func disconnect() {
    calls.append(.disconnect)
  }

  func waitUntilReconnecting() async {
    await gate.waitUntilWaiting()
  }

  func releaseReconnect() async {
    await gate.release()
  }

  private func cancelReconnect() async {
    calls.append(.reconnectCancelled)
    await gate.release()
  }
}

private actor CancellableSettingsLifecycle {
  enum Event: Equatable, Sendable {
    case verifyStarted
    case verifyCancelled
    case deleteSecrets
  }

  private let gate = TestGate()
  private(set) var events: [Event] = []

  func verify() async throws {
    events.append(.verifyStarted)
    try await withTaskCancellationHandler {
      await gate.wait()
      try Task.checkCancellation()
    } onCancel: {
      Task { await self.cancelVerification() }
    }
  }

  func deleteSecrets() {
    events.append(.deleteSecrets)
  }

  func waitUntilVerifying() async {
    await gate.waitUntilWaiting()
  }

  func releaseVerification() async {
    await gate.release()
  }

  private func cancelVerification() async {
    events.append(.verifyCancelled)
    await gate.release()
  }
}

private actor SettingsLifecycleRecorder {
  enum Event: Equatable, Sendable {
    case verify
    case bootstrap
  }

  private(set) var values: [Event] = []

  func record(_ value: Event) {
    values.append(value)
  }

  func clear() {
    values.removeAll()
  }
}

private actor SettingsSyncEngine: AppSyncing {
  private let events: SettingsLifecycleRecorder?

  init(events: SettingsLifecycleRecorder? = nil) {
    self.events = events
  }

  func snapshots() -> AsyncStream<SyncSnapshot> {
    AsyncStream { $0.finish() }
  }

  func bootstrap() async {
    await events?.record(.bootstrap)
  }

  func sceneDidEnterBackground() {}
  func sceneWillEnterForeground() {}
  func shutdown() {}
}

private enum SettingsTestError: Error {
  case failed
}

private actor SettingsGatewayStub: GatewayProfileChecking {
  enum Call: Equatable, Sendable {
    case health
    case identity
    case shutdown
  }

  private let status: String
  private let apiVersion: Int
  private let capabilities: [MobileCapability]
  private let identityValue: GatewayIdentityDTO
  private(set) var calls: [Call] = []

  init(
    status: String = "healthy",
    apiVersion: Int = 1,
    capabilities: [MobileCapability] = [.conversationSyncV1, .chatResumeV1],
    identity: GatewayIdentityDTO = GatewayIdentityDTO(
      gatewayId: "gateway-settings",
      publicKey: "abcdef-public-key-uvwxyz"
    )
  ) {
    self.status = status
    self.apiVersion = apiVersion
    self.capabilities = capabilities
    identityValue = identity
  }

  func health() -> HealthResponse {
    calls.append(.health)
    return HealthResponse(
      status: status,
      startedAt: Date(timeIntervalSince1970: 1),
      pid: 1,
      agents: 1,
      channels: 0,
      apiVersion: apiVersion,
      capabilities: capabilities
    )
  }

  func identity() -> GatewayIdentityDTO {
    calls.append(.identity)
    return identityValue
  }

  func shutdown() {
    calls.append(.shutdown)
  }
}

private actor CancellationIgnoringSettingsGateway: GatewayProfileChecking {
  enum Call: Equatable, Sendable {
    case health
    case identity
    case shutdown
  }

  private let healthGate = TestGate()
  private(set) var calls: [Call] = []

  func health() async -> HealthResponse {
    calls.append(.health)
    await healthGate.wait()
    return HealthResponse(
      status: "healthy",
      startedAt: Date(timeIntervalSince1970: 1),
      pid: 1,
      agents: 1,
      channels: 0,
      apiVersion: 1,
      capabilities: [.conversationSyncV1, .chatResumeV1]
    )
  }

  func identity() -> GatewayIdentityDTO {
    calls.append(.identity)
    return GatewayIdentityDTO(
      gatewayId: "gateway-settings",
      publicKey: "abcdef-public-key-uvwxyz"
    )
  }

  func shutdown() {
    calls.append(.shutdown)
  }

  func waitUntilCheckingHealth() async {
    await healthGate.waitUntilWaiting()
  }

  func releaseHealth() async {
    await healthGate.release()
  }
}
