import AVFoundation
import Foundation
import Testing

@testable import Dash

@Suite("Pairing feature", .serialized)
@MainActor
struct PairingFeatureTests {
  @Test("verification probes health, identity, agents, then chat before returning identity")
  func verificationOrder() async throws {
    let recorder = PairingCallRecorder()
    let gateway = FakePairingGateway(recorder: recorder)
    let chat = FakePairingChatProbe(recorder: recorder)
    let profileID = UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-2234567890ab")!
    let verifier = PairingVerifier(
      makeGateway: { _, _ in gateway },
      makeChat: { _ in chat },
      makeProfileID: { profileID }
    )
    var steps: [PairingVerificationStep] = []

    let result = try await verifier.verify(payload: lanPayload()) { steps.append($0) }

    #expect(await recorder.values == [.health, .identity, .agents, .chat])
    #expect(steps == [.reachability, .capabilities, .identity, .agents, .chat])
    #expect(result.profile.id == profileID)
    #expect(result.profile.gatewayID == "gateway-verified")
    #expect(result.profile.profile.gatewayId == "gateway-verified")
    #expect(result.profile.profile.publicKey == "public-key-verified")
  }

  @Test("verification requires both resumable conversation capabilities")
  func capabilityGate() async {
    let incompleteCapabilities: [[MobileCapability]] = [
      [],
      [.conversationSyncV1],
      [.chatResumeV1],
    ]

    for capabilities in incompleteCapabilities {
      let recorder = PairingCallRecorder()
      let gateway = FakePairingGateway(recorder: recorder, capabilities: capabilities)
      let chat = FakePairingChatProbe(recorder: recorder)
      let verifier = PairingVerifier(
        makeGateway: { _, _ in gateway },
        makeChat: { _ in chat }
      )

      await #expect(throws: GatewayError.capabilityRequired) {
        try await verifier.verify(payload: lanPayload()) { _ in }
      }
      #expect(await recorder.values == [.health])
    }
  }

  @Test("successful pairing verifies before Keychain, metadata, and activation")
  func persistenceOrder() async throws {
    let recorder = PairingCallRecorder()
    let gateway = FakePairingGateway(recorder: recorder)
    let chat = FakePairingChatProbe(recorder: recorder)
    let keychain = RecordingPairingKeychain(recorder: recorder)
    let metadata = RecordingPairingMetadata(recorder: recorder)
    let verifier = PairingVerifier(
      makeGateway: { _, _ in gateway },
      makeChat: { _ in chat },
      makeProfileID: {
        UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-2234567890ab")!
      }
    )
    let feature = PairingFeature(
      verifier: verifier,
      installer: PairingProfileInstaller(keychain: keychain, metadata: metadata),
      onPaired: { _ in await recorder.append(.activated) }
    )

    await feature.pair(rawPayload: lanPayloadJSON)

    #expect(
      await recorder.values
        == [.health, .identity, .agents, .chat, .keychainSave, .metadataSave, .activated]
    )
    guard case .paired(let profile) = feature.state else {
      Issue.record("Expected paired state, received \(feature.state)")
      return
    }
    #expect(profile.gatewayID == "gateway-verified")
    #expect(await keychain.savedProfileIDs == [profile.id])
    #expect(await metadata.savedGatewayIDs == [profile.gatewayID])
    #expect(await metadata.savedPublicKeys == ["public-key-verified"])
  }

  @Test("metadata failure rolls the new Keychain value back and never activates")
  func metadataRollback() async {
    let recorder = PairingCallRecorder()
    let gateway = FakePairingGateway(recorder: recorder)
    let chat = FakePairingChatProbe(recorder: recorder)
    let keychain = RecordingPairingKeychain(recorder: recorder)
    let metadata = RecordingPairingMetadata(recorder: recorder, saveError: PairingTestError.save)
    let feature = PairingFeature(
      verifier: PairingVerifier(
        makeGateway: { _, _ in gateway },
        makeChat: { _ in chat }
      ),
      installer: PairingProfileInstaller(keychain: keychain, metadata: metadata),
      onPaired: { _ in await recorder.append(.activated) }
    )

    await feature.pair(rawPayload: lanPayloadJSON)

    #expect(
      await recorder.values
        == [.health, .identity, .agents, .chat, .keychainSave, .metadataSave, .keychainDelete]
    )
    guard case .failed(let failure) = feature.state else {
      Issue.record("Expected failed state, received \(feature.state)")
      return
    }
    #expect(failure.title == "Couldn't save connection")
  }

  @Test("Keychain failure never writes profile metadata or activates")
  func keychainFailureStopsInstallation() async {
    let recorder = PairingCallRecorder()
    let gateway = FakePairingGateway(recorder: recorder)
    let chat = FakePairingChatProbe(recorder: recorder)
    let keychain = RecordingPairingKeychain(recorder: recorder, saveError: PairingTestError.save)
    let metadata = RecordingPairingMetadata(recorder: recorder)
    let feature = PairingFeature(
      verifier: PairingVerifier(
        makeGateway: { _, _ in gateway },
        makeChat: { _ in chat }
      ),
      installer: PairingProfileInstaller(keychain: keychain, metadata: metadata),
      onPaired: { _ in await recorder.append(.activated) }
    )

    await feature.pair(rawPayload: lanPayloadJSON)

    #expect(
      await recorder.values == [.health, .identity, .agents, .chat, .keychainSave]
    )
    #expect(await metadata.savedGatewayIDs.isEmpty)
    guard case .failed(let failure) = feature.state else {
      Issue.record("Expected failed state, received \(feature.state)")
      return
    }
    #expect(failure.title == "Couldn't save connection")
  }

  @Test("relay manual entry constructs the canonical v2 TLS payload")
  func relayManualEntry() async throws {
    let verifier = CapturingPairingVerifier()
    let feature = PairingFeature(
      verifier: verifier,
      installer: NoopPairingInstaller(),
      onPaired: { _ in }
    )

    await feature.pair(
      manual: ManualPairingInput(
        mode: .relay,
        host: "relay.example",
        managementPort: "1234",
        chatPort: "5678",
        secure: false,
        managementToken: " management ",
        chatToken: " chat ",
        relayCredential: " relay "
      )
    )

    let payload = try #require(await verifier.payloads.first)
    #expect(payload.v == 2)
    #expect(payload.host == "relay.example")
    #expect(payload.secure == true)
    #expect(payload.mgmtPort == nil)
    #expect(payload.chatPort == nil)
    #expect(payload.relayCredential == " relay ")
    let (profile, secrets) = try payload.validated(profileID: UUID())
    #expect(profile.managementPort == 443)
    #expect(profile.chatPort == 443)
    #expect(secrets.managementToken == "management")
    #expect(secrets.chatToken == "chat")
    #expect(secrets.relayCredential == "relay")
  }

  @Test("invalid LAN port stops before any verification")
  func invalidManualPort() async {
    let verifier = CapturingPairingVerifier()
    let feature = PairingFeature(
      verifier: verifier,
      installer: NoopPairingInstaller(),
      onPaired: { _ in }
    )

    await feature.pair(
      manual: ManualPairingInput(
        mode: .lan,
        host: "gateway.local",
        managementPort: "not-a-port",
        chatPort: "9200",
        secure: false,
        managementToken: "management",
        chatToken: "chat",
        relayCredential: ""
      )
    )

    #expect(await verifier.payloads.isEmpty)
    guard case .failed(let failure) = feature.state else {
      Issue.record("Expected failed state, received \(feature.state)")
      return
    }
    #expect(failure.title == "Invalid connection details")
  }

  @Test("gateway failures use curated recovery copy")
  func curatedFailures() async {
    let cases: [(GatewayError, String, String)] = [
      (.unauthorized, "Re-pair this device", "credentials"),
      (.capabilityRequired, "Update Dash", "conversation sync"),
      (.updateRequired, "Update Dash", "compatible"),
      (.gatewayOffline, "Gateway offline", "relay"),
      (.transport("secret raw failure"), "Gateway offline", "reachable"),
      (.rateLimited(retryAfter: .seconds(30)), "Too many requests", "30 seconds"),
    ]

    for (error, title, messageFragment) in cases {
      let feature = PairingFeature(
        verifier: CapturingPairingVerifier(error: error),
        installer: NoopPairingInstaller(),
        onPaired: { _ in }
      )
      await feature.pair(rawPayload: lanPayloadJSON)
      guard case .failed(let failure) = feature.state else {
        Issue.record("Expected failure for \(error), received \(feature.state)")
        continue
      }
      #expect(failure.title == title)
      #expect(failure.message.localizedCaseInsensitiveContains(messageFragment))
      #expect(failure.message.contains("secret raw failure") == false)
    }
  }

  @Test("a curated pairing failure is announced without raw transport details")
  func pairingFailureAnnouncement() async {
    let announcements = PairingAnnouncementRecorder()
    let feature = PairingFeature(
      verifier: CapturingPairingVerifier(error: .transport("secret raw failure")),
      installer: NoopPairingInstaller(),
      onPaired: { _ in },
      announceFailure: { failure in
        announcements.values.append("\(failure.title). \(failure.message)")
      }
    )

    await feature.pair(rawPayload: lanPayloadJSON)

    #expect(
      announcements.values
        == [
          "Gateway offline. Make sure the gateway is running and reachable, then try again."
        ]
    )
    #expect(announcements.values.first?.contains("secret raw failure") == false)
  }

  @Test("camera denial keeps paste and manual alternatives available")
  func cameraDenialFallback() async {
    let scanner = FakeQRScanner(status: .denied)
    let feature = PairingFeature(
      verifier: CapturingPairingVerifier(),
      installer: NoopPairingInstaller(),
      scanner: scanner,
      onPaired: { _ in }
    )

    await feature.requestCameraAndScan()

    #expect(feature.cameraAuthorization == .denied)
    #expect(feature.canPastePairingCode)
    #expect(feature.canEnterManually)
    #expect(await scanner.scanCallCount == 0)
  }

  @Test("a QR result arriving after scanning stops is ignored")
  func stoppedScannerIgnoresLateResult() async {
    let scanner = ControllableQRScanner()
    let verifier = CapturingPairingVerifier()
    let feature = PairingFeature(
      verifier: verifier,
      installer: NoopPairingInstaller(),
      scanner: scanner,
      onPaired: { _ in }
    )

    let scanTask = Task { await feature.requestCameraAndScan() }
    for _ in 0..<100 where await scanner.scanCallCount == 0 {
      await Task.yield()
    }
    #expect(await scanner.scanCallCount == 1)

    await feature.stopScanning()
    await scanner.returnLateResult(lanPayloadJSON)
    await scanTask.value

    #expect(await verifier.payloads.isEmpty)
    #expect(feature.state == .idle)
  }

  @Test("cancelling a scan during startup stops the runtime before startup returns")
  func scannerCancellationCoversStartup() async {
    let gate = TestGate()
    let runtime = DelayedQRScannerRuntime(gate: gate)
    let scanner = QRScannerService(runtime: runtime)
    let scan = Task { try await scanner.scan() }
    await gate.waitUntilWaiting()

    scan.cancel()
    await gate.release()

    await #expect(throws: QRScannerError.stopped) {
      try await scan.value
    }
    #expect(runtime.stoppedBeforeStartReturned)
    #expect(runtime.stopCallCount >= 1)
  }

  @Test("a pairing attempt already in flight rejects a second payload")
  func pairingIsSingleFlight() async {
    let gate = TestGate()
    let verifier = FirstCallBlockingPairingVerifier(gate: gate)
    let feature = PairingFeature(
      verifier: verifier,
      installer: NoopPairingInstaller(),
      onPaired: { _ in }
    )

    let first = Task { await feature.pair(rawPayload: lanPayloadJSON) }
    await gate.waitUntilWaiting()

    await feature.pair(rawPayload: relayPayloadJSON)

    #expect(await verifier.payloadVersions == [1])
    await gate.release()
    await first.value
  }

  @Test("AppDependencies pairing factory installs the verified profile through AppModel")
  func appComposition() async {
    let verifier = CapturingPairingVerifier()
    let engine = PairingSyncEngine()
    let dependencies = AppDependencies(
      clock: TestAppClock(now: Date(timeIntervalSince1970: 1)),
      loadProfile: { nil },
      makeSyncEngine: { _ in engine },
      pairingFeatureFactory: PairingFeatureFactory(
        verifier: verifier,
        installer: NoopPairingInstaller()
      )
    )
    let appModel = AppModel(dependencies: dependencies)
    let feature = appModel.makePairingFeature()

    await feature.pair(rawPayload: lanPayloadJSON)

    #expect(appModel.selectedProfile?.gatewayID == "gateway-captured")
    #expect(appModel.route == .paired(tab: .conversations))
    #expect(await engine.bootstrapCallCount == 1)
  }
}

private enum PairingRecordedCall: Equatable, Sendable {
  case health
  case identity
  case agents
  case chat
  case keychainSave
  case metadataSave
  case keychainDelete
  case activated
}

private actor PairingCallRecorder {
  private(set) var values: [PairingRecordedCall] = []

  func append(_ value: PairingRecordedCall) {
    values.append(value)
  }
}

private actor FakePairingGateway: PairingGatewayChecking {
  let recorder: PairingCallRecorder
  let capabilities: [MobileCapability]

  init(
    recorder: PairingCallRecorder,
    capabilities: [MobileCapability] = [.conversationSyncV1, .chatResumeV1]
  ) {
    self.recorder = recorder
    self.capabilities = capabilities
  }

  func health() async throws -> HealthResponse {
    await recorder.append(.health)
    return HealthResponse(
      status: "ok",
      startedAt: Date(timeIntervalSince1970: 1),
      pid: 1,
      agents: 1,
      channels: 0,
      apiVersion: 1,
      capabilities: capabilities
    )
  }

  func identity() async throws -> GatewayIdentityDTO {
    await recorder.append(.identity)
    return GatewayIdentityDTO(gatewayId: "gateway-verified", publicKey: "public-key-verified")
  }

  func listAgents() async throws -> [RegisteredAgentDTO] {
    await recorder.append(.agents)
    return []
  }
}

private actor FakePairingChatProbe: PairingChatChecking {
  let recorder: PairingCallRecorder

  init(recorder: PairingCallRecorder) {
    self.recorder = recorder
  }

  func probeAuthentication() async throws {
    await recorder.append(.chat)
  }
}

private enum PairingTestError: Error {
  case save
}

private actor RecordingPairingKeychain: KeychainStoring {
  let recorder: PairingCallRecorder
  let shouldFailSave: Bool
  private(set) var savedProfileIDs: [UUID] = []

  init(recorder: PairingCallRecorder, saveError: (any Error)? = nil) {
    self.recorder = recorder
    shouldFailSave = saveError != nil
  }

  func save(_ secrets: ConnectionSecrets, for profileID: UUID) async throws {
    _ = secrets
    savedProfileIDs.append(profileID)
    await recorder.append(.keychainSave)
    if shouldFailSave {
      throw PairingTestError.save
    }
  }

  func load(for profileID: UUID) async throws -> ConnectionSecrets? {
    _ = profileID
    return nil
  }

  func delete(for profileID: UUID) async throws {
    _ = profileID
    await recorder.append(.keychainDelete)
  }
}

private actor RecordingPairingMetadata: PairingMetadataStoring {
  let recorder: PairingCallRecorder
  let shouldFail: Bool
  private(set) var savedGatewayIDs: [String] = []
  private(set) var savedPublicKeys: [String] = []

  init(recorder: PairingCallRecorder, saveError: (any Error)? = nil) {
    self.recorder = recorder
    shouldFail = saveError != nil
  }

  func savePairingProfile(
    _ profile: ConnectionProfile,
    identity: GatewayIdentityDTO
  ) async throws {
    savedGatewayIDs.append(identity.gatewayId)
    if let publicKey = profile.publicKey {
      savedPublicKeys.append(publicKey)
    }
    await recorder.append(.metadataSave)
    if shouldFail {
      throw PairingTestError.save
    }
  }
}

private actor CapturingPairingVerifier: PairingVerifying {
  let error: GatewayError?
  private(set) var payloads: [PairingPayload] = []

  init(error: GatewayError? = nil) {
    self.error = error
  }

  func verify(
    payload: PairingPayload,
    onStep: @escaping @MainActor @Sendable (PairingVerificationStep) -> Void
  ) async throws -> VerifiedPairing {
    payloads.append(payload)
    await onStep(.reachability)
    if let error {
      throw error
    }
    let (profile, secrets) = try payload.validated(profileID: UUID())
    let identity = GatewayIdentityDTO(
      gatewayId: "gateway-captured",
      publicKey: "public-key-captured"
    )
    var identified = profile
    identified.gatewayId = identity.gatewayId
    identified.publicKey = identity.publicKey
    return VerifiedPairing(
      profile: ConnectionProfileSnapshot(gatewayID: identity.gatewayId, profile: identified),
      identity: identity,
      secrets: secrets
    )
  }
}

private actor FirstCallBlockingPairingVerifier: PairingVerifying {
  let gate: TestGate
  private(set) var payloadVersions: [Int] = []

  init(gate: TestGate) {
    self.gate = gate
  }

  func verify(
    payload: PairingPayload,
    onStep: @escaping @MainActor @Sendable (PairingVerificationStep) -> Void
  ) async throws -> VerifiedPairing {
    payloadVersions.append(payload.v)
    if payloadVersions.count == 1 {
      await gate.wait()
    }
    await onStep(.reachability)
    let (profile, secrets) = try payload.validated(profileID: UUID())
    let identity = GatewayIdentityDTO(
      gatewayId: "gateway-\(payload.v)",
      publicKey: "public-key-\(payload.v)"
    )
    var identified = profile
    identified.gatewayId = identity.gatewayId
    identified.publicKey = identity.publicKey
    return VerifiedPairing(
      profile: ConnectionProfileSnapshot(gatewayID: identity.gatewayId, profile: identified),
      identity: identity,
      secrets: secrets
    )
  }
}

private actor NoopPairingInstaller: PairingProfileInstalling {
  func install(_ pairing: VerifiedPairing) async throws {
    _ = pairing
  }
}

private actor FakeQRScanner: QRScanning {
  let status: AVAuthorizationStatus
  private(set) var scanCallCount = 0

  init(status: AVAuthorizationStatus) {
    self.status = status
  }

  func authorizationStatus() -> AVAuthorizationStatus {
    status
  }

  func requestAccess() async -> Bool {
    false
  }

  func scan() async throws -> String {
    scanCallCount += 1
    return lanPayloadJSON
  }

  func stop() {
  }
}

private actor ControllableQRScanner: QRScanning {
  private(set) var scanCallCount = 0
  private var continuation: CheckedContinuation<String, any Error>?

  func authorizationStatus() -> AVAuthorizationStatus {
    .authorized
  }

  func requestAccess() async -> Bool {
    true
  }

  func scan() async throws -> String {
    scanCallCount += 1
    return try await withCheckedThrowingContinuation { continuation in
      self.continuation = continuation
    }
  }

  func stop() {}

  func returnLateResult(_ payload: String) {
    continuation?.resume(returning: payload)
    continuation = nil
  }
}

private final class DelayedQRScannerRuntime: QRScannerRuntimeControlling, @unchecked Sendable {
  let gate: TestGate
  private let lock = NSLock()
  private var isStopped = false
  private var recordedStopCallCount = 0
  private var recordedStoppedBeforeStartReturned = false

  init(gate: TestGate) {
    self.gate = gate
  }

  func start() async throws -> AsyncStream<String> {
    await gate.wait()
    recordStopStateAtStartReturn()
    return AsyncStream { continuation in continuation.finish() }
  }

  private func recordStopStateAtStartReturn() {
    lock.lock()
    recordedStoppedBeforeStartReturned = isStopped
    lock.unlock()
  }

  func stop() {
    lock.lock()
    isStopped = true
    recordedStopCallCount += 1
    lock.unlock()
  }

  var stoppedBeforeStartReturned: Bool {
    lock.lock()
    defer { lock.unlock() }
    return recordedStoppedBeforeStartReturned
  }

  var stopCallCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return recordedStopCallCount
  }
}

private actor PairingSyncEngine: AppSyncing {
  private(set) var bootstrapCallCount = 0

  func snapshots() -> AsyncStream<SyncSnapshot> {
    AsyncStream { _ in }
  }

  func bootstrap() async {
    bootstrapCallCount += 1
  }

  func sceneDidEnterBackground() async {}
  func sceneWillEnterForeground() async {}
  func shutdown() async {}
}

@MainActor
private final class PairingAnnouncementRecorder {
  var values: [String] = []
}

private func lanPayload() -> PairingPayload {
  PairingPayload(
    v: 1,
    host: "gateway.local",
    mgmtToken: "management-token",
    chatToken: "chat-token",
    mgmtPort: 9300,
    chatPort: 9200,
    label: "Home",
    secure: false,
    relayCredential: nil
  )
}

private let lanPayloadJSON = """
  {
    "v": 1,
    "host": "gateway.local",
    "mgmtToken": "management-token",
    "chatToken": "chat-token",
    "mgmtPort": 9300,
    "chatPort": 9200,
    "label": "Home",
    "secure": false
  }
  """

private let relayPayloadJSON = """
  {
    "v": 2,
    "host": "relay.example",
    "mgmtToken": "management-token-2",
    "chatToken": "chat-token-2",
    "relayCredential": "relay-credential"
  }
  """
