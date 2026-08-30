import AVFoundation
import Foundation
import Testing
import UIKit

@testable import Dash

/// Covers the verify → install pipeline (`PairingVerifier`,
/// `PairingProfileInstaller`, `VerifiedPairing`, `PairingCancellation`) and
/// `PairingFeature`'s payload-driven orchestration, plus the still-shipping
/// `QRScannerService`/camera-preview mechanics. QR/paste/manual pairing ENTRY
/// (scanning into `PairingFeature`, clipboard paste, the manual-entry form)
/// was retired in Task 7 of the iOS account sign-in plan — those tests moved
/// with the retired code; this file keeps everything downstream of an
/// already-formed `PairingPayload`, which `AccountConnectFeature` now reaches
/// directly.
@Suite("Pairing pipeline", .serialized)
@MainActor
struct PairingPipelineTests {
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

  @Test("verification rejects unhealthy or incompatible mobile APIs before identity")
  func healthContractGate() async {
    let cases: [(status: String, apiVersion: Int, expected: GatewayError)] = [
      ("starting", 1, .gatewayOffline),
      ("healthy", 2, .updateRequired),
    ]

    for value in cases {
      let recorder = PairingCallRecorder()
      let gateway = FakePairingGateway(
        recorder: recorder,
        status: value.status,
        apiVersion: value.apiVersion
      )
      let verifier = PairingVerifier(
        makeGateway: { _, _ in gateway },
        makeChat: { _ in FakePairingChatProbe(recorder: recorder) }
      )

      await #expect(throws: value.expected) {
        try await verifier.verify(payload: lanPayload()) { _ in }
      }
      #expect(await recorder.values == [.health])
    }
  }

  @Test("blank gateway identity fields stop before persistence or activation")
  func blankGatewayIdentityStopsPairing() async {
    let invalidIdentities = [
      GatewayIdentityDTO(gatewayId: "", publicKey: "public-key"),
      GatewayIdentityDTO(gatewayId: " \n ", publicKey: "public-key"),
      GatewayIdentityDTO(gatewayId: "gateway", publicKey: ""),
      GatewayIdentityDTO(gatewayId: "gateway", publicKey: " \t "),
    ]

    for identity in invalidIdentities {
      let recorder = PairingCallRecorder()
      let gateway = FakePairingGateway(
        recorder: recorder,
        gatewayID: identity.gatewayId,
        publicKey: identity.publicKey
      )
      let keychain = RecordingPairingKeychain(recorder: recorder)
      let metadata = RecordingPairingMetadata(recorder: recorder)
      let feature = PairingFeature(
        verifier: PairingVerifier(
          makeGateway: { _, _ in gateway },
          makeChat: { _ in FakePairingChatProbe(recorder: recorder) }
        ),
        installer: PairingProfileInstaller(keychain: keychain, metadata: metadata),
        onPaired: { _ in await recorder.append(.activated) }
      )

      await feature.pair(payload: lanPayload())

      #expect(await recorder.values == [.health, .identity])
      #expect(await keychain.savedProfileIDs.isEmpty)
      #expect(await metadata.savedGatewayIDs.isEmpty)
      guard case .failed(let failure) = feature.state else {
        Issue.record("Expected invalid identity failure, received \(feature.state)")
        continue
      }
      #expect(failure.title == "Invalid connection details")
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

    await feature.pair(payload: lanPayload())

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

    await feature.pair(payload: lanPayload())

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

    await feature.pair(payload: lanPayload())

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

  @Test("same-gateway pairing reuses the canonical profile and Keychain account")
  func sameGatewayPairingReusesCanonicalProfile() async throws {
    let recorder = PairingCallRecorder()
    let canonicalID = UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-111111111111")!
    let proposedID = UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-222222222222")!
    let priorSecrets = ConnectionSecrets(
      managementToken: "old-management",
      chatToken: "old-chat",
      relayCredential: nil
    )
    let replacementSecrets = ConnectionSecrets(
      managementToken: "new-management",
      chatToken: "new-chat",
      relayCredential: nil
    )
    let existing = existingPairingProfile(id: canonicalID)
    let pairing = verifiedPairing(id: proposedID, secrets: replacementSecrets)
    let keychain = RecordingPairingKeychain(
      recorder: recorder,
      initialSecrets: [canonicalID: priorSecrets]
    )
    let metadata = RecordingPairingMetadata(recorder: recorder, existingProfile: existing)
    let installer = PairingProfileInstaller(keychain: keychain, metadata: metadata)

    let installed = try await installer.install(pairing)

    #expect(installed.id == canonicalID)
    #expect(await keychain.storedSecrets == [canonicalID: replacementSecrets])
    #expect(await keychain.savedProfileIDs == [canonicalID])
    let saved = try #require(await metadata.savedProfiles.first)
    #expect(saved.id == canonicalID)
    #expect(saved.createdAt == existing.profile.createdAt)
    #expect(saved.lastSuccessfulSyncAt == existing.profile.lastSuccessfulSyncAt)
    #expect(saved.tlsCertificateSha256 == pairing.profile.profile.tlsCertificateSha256)
  }

  @Test("same-gateway metadata failure restores prior Keychain secret bytes")
  func sameGatewayMetadataFailureRestoresPriorSecrets() async {
    let recorder = PairingCallRecorder()
    let canonicalID = UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-333333333333")!
    let proposedID = UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-444444444444")!
    let priorSecrets = ConnectionSecrets(
      managementToken: "old-management-exact",
      chatToken: "old-chat-exact",
      relayCredential: "old-relay-exact"
    )
    let replacementSecrets = ConnectionSecrets(
      managementToken: "new-management",
      chatToken: "new-chat",
      relayCredential: "new-relay"
    )
    let keychain = RecordingPairingKeychain(
      recorder: recorder,
      initialSecrets: [canonicalID: priorSecrets]
    )
    let metadata = RecordingPairingMetadata(
      recorder: recorder,
      saveError: PairingTestError.save,
      existingProfile: existingPairingProfile(id: canonicalID)
    )
    let installer = PairingProfileInstaller(keychain: keychain, metadata: metadata)

    await #expect(throws: PairingInstallError.metadata) {
      try await installer.install(verifiedPairing(id: proposedID, secrets: replacementSecrets))
    }

    #expect(await keychain.storedSecrets == [canonicalID: priorSecrets])
    #expect(await keychain.savedProfileIDs == [canonicalID, canonicalID])
    #expect(await keychain.savedSecrets == [replacementSecrets, priorSecrets])
    #expect(await keychain.deletedProfileIDs.isEmpty)
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
      await feature.pair(payload: lanPayload())
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

    await feature.pair(payload: lanPayload())

    #expect(
      announcements.values
        == [
          "Gateway offline. Make sure the gateway is running and reachable, then try again."
        ]
    )
    #expect(announcements.values.first?.contains("secret raw failure") == false)
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

  @Test("camera preview attaches, remains silent to VoiceOver, and detaches its session")
  func cameraPreviewLifecycle() {
    let session = AVCaptureSession()
    let source = QRScannerPreviewSource(session: session)
    let preview = QRScannerPreviewView(frame: .zero)

    preview.attach(source)

    #expect(preview.previewLayer.session === session)
    #expect(preview.accessibilityElementsHidden)

    preview.detach()

    #expect(preview.previewLayer.session == nil)
  }

  @Test("camera preview maps and applies every supported interface orientation")
  func cameraPreviewRotation() {
    let expected: [(UIInterfaceOrientation, CGFloat)] = [
      (.portrait, 90),
      (.portraitUpsideDown, 270),
      (.landscapeLeft, 180),
      (.landscapeRight, 0),
    ]
    let connection = RecordingPreviewRotationConnection(
      supportedAngles: Set(expected.map(\.1))
    )

    for (orientation, angle) in expected {
      #expect(QRScannerPreviewRotation.angle(for: orientation) == angle)
      QRScannerPreviewRotation.update(connection, for: orientation)
      #expect(connection.videoRotationAngle == angle)
    }

    QRScannerPreviewRotation.update(connection, for: .unknown)

    #expect(connection.appliedAngles == expected.map(\.1))
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

    let first = Task { await feature.pair(payload: lanPayload()) }
    await gate.waitUntilWaiting()

    await feature.pair(payload: relayPayload())

    #expect(await verifier.payloadVersions == [3])
    await gate.release()
    await first.value
  }

  @Test("closing during verification prevents persistence, activation, and announcements")
  func closeDuringVerificationCancelsPairing() async {
    let gate = TestGate()
    let verifier = FirstCallBlockingPairingVerifier(gate: gate)
    let installer = RecordingPairingInstaller()
    let announcements = PairingAnnouncementRecorder()
    let feature = PairingFeature(
      verifier: verifier,
      installer: installer,
      onPaired: { _ in Issue.record("Cancelled pairing must not activate") },
      announceFailure: { failure in
        announcements.values.append("\(failure.title). \(failure.message)")
      }
    )

    let pairing = Task { await feature.pair(payload: lanPayload()) }
    await gate.waitUntilWaiting()

    feature.cancelPairing()
    await gate.release()
    await pairing.value

    #expect(await installer.installCallCount == 0)
    #expect(announcements.values.isEmpty)
    #expect(feature.state == .idle)
  }

  @Test("cancelling after Keychain save rolls back without metadata, activation, or announcement")
  func cancellationAfterKeychainSaveRollsBack() async {
    let gate = TestGate()
    let recorder = PairingCallRecorder()
    let keychain = RecordingPairingKeychain(recorder: recorder, pauseAfterFirstSave: gate)
    let metadata = RecordingPairingMetadata(recorder: recorder)
    let announcements = PairingAnnouncementRecorder()
    let feature = PairingFeature(
      verifier: CapturingPairingVerifier(),
      installer: PairingProfileInstaller(keychain: keychain, metadata: metadata),
      onPaired: { _ in await recorder.append(.activated) },
      announceFailure: { failure in
        announcements.values.append("\(failure.title). \(failure.message)")
      }
    )

    let pairing = Task { await feature.pair(payload: lanPayload()) }
    await gate.waitUntilWaiting()

    feature.cancelPairing()
    await gate.release()
    await pairing.value

    #expect(await keychain.storedSecrets.isEmpty)
    #expect(await keychain.deletedProfileIDs.count == 1)
    #expect(await metadata.savedGatewayIDs.isEmpty)
    #expect(await recorder.values.contains(.activated) == false)
    #expect(announcements.values.isEmpty)
    #expect(feature.state == .idle)
  }

  @Test("cancelling after same-gateway metadata commit still completes activation coherently")
  func cancellationAfterMetadataCommitCompletesActivation() async throws {
    let gate = TestGate()
    let recorder = PairingCallRecorder()
    let canonicalID = UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-555555555555")!
    let priorSecrets = ConnectionSecrets(
      managementToken: "old-management",
      chatToken: "old-chat",
      relayCredential: nil
    )
    let replacementSecrets = ConnectionSecrets(
      managementToken: "mobile-token",
      chatToken: "mobile-token",
      relayCredential: nil
    )
    let keychain = RecordingPairingKeychain(
      recorder: recorder,
      initialSecrets: [canonicalID: priorSecrets]
    )
    let metadata = RecordingPairingMetadata(
      recorder: recorder,
      existingProfile: existingPairingProfile(id: canonicalID),
      pauseAfterFirstSave: gate
    )
    let gateway = FakePairingGateway(recorder: recorder)
    let feature = PairingFeature(
      verifier: PairingVerifier(
        makeGateway: { _, _ in gateway },
        makeChat: { _ in FakePairingChatProbe(recorder: recorder) }
      ),
      installer: PairingProfileInstaller(keychain: keychain, metadata: metadata),
      onPaired: { _ in await recorder.append(.activated) }
    )

    let pairing = Task { await feature.pair(payload: lanPayload()) }
    await gate.waitUntilWaiting()

    feature.cancelPairing()

    #expect(feature.state == .verifying(.saving))
    await gate.release()
    await pairing.value

    guard case .paired(let installed) = feature.state else {
      Issue.record("Expected committed pairing to activate, received \(feature.state)")
      return
    }
    #expect(installed.id == canonicalID)
    #expect(await keychain.storedSecrets == [canonicalID: replacementSecrets])
    let saved = try #require(await metadata.savedProfiles.last)
    #expect(saved.id == canonicalID)
    #expect(saved.gatewayId == installed.gatewayID)
    #expect(saved.publicKey == "public-key-verified")
    #expect(await recorder.values.last == .activated)
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

    await feature.pair(payload: lanPayload())

    #expect(appModel.selectedProfile?.gatewayID == "gateway-captured")
    #expect(appModel.route == .paired(tab: .conversations))
    #expect(await engine.bootstrapCallCount == 1)
  }

  @Test("activation failure and retry avoid a stale duplicate global banner")
  func activationFailureRemainsRetryable() async {
    let verifier = CapturingPairingVerifier()
    let retryGate = TestGate()
    let retryEngine = PairingSyncEngine()
    let engineFactory = FailThenBlockPairingEngineFactory(
      retryGate: retryGate,
      retryEngine: retryEngine
    )
    let dependencies = AppDependencies(
      clock: TestAppClock(now: Date(timeIntervalSince1970: 1)),
      loadProfile: { nil },
      makeSyncEngine: { profile in try await engineFactory.make(profile) },
      pairingFeatureFactory: PairingFeatureFactory(
        verifier: verifier,
        installer: NoopPairingInstaller()
      )
    )
    let appModel = AppModel(dependencies: dependencies)
    let feature = appModel.makePairingFeature()

    await feature.pair(payload: lanPayload())

    #expect(appModel.selectedProfile == nil)
    #expect(appModel.route == .connect)
    guard case .failed(let failure) = feature.state else {
      Issue.record("Expected retryable failure, received \(feature.state)")
      return
    }
    #expect(failure.title == "Couldn't connect")
    #expect(failure.message.contains("activation") == false)
    #expect(appModel.banner == nil)

    appModel.banner = .failed("stale activation failure")
    let retry = Task { await feature.pair(payload: lanPayload()) }
    await retryGate.waitUntilWaiting()

    #expect(appModel.banner == nil)

    await retryGate.release()
    await retry.value

    #expect(appModel.selectedProfile?.gatewayID == "gateway-captured")
    #expect(feature.state.isWorking == false)
    #expect(appModel.banner == nil)
    #expect(await retryEngine.bootstrapCallCount == 1)
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
  let status: String
  let apiVersion: Int
  let capabilities: [MobileCapability]
  let gatewayID: String
  let publicKey: String

  init(
    recorder: PairingCallRecorder,
    status: String = "healthy",
    apiVersion: Int = 1,
    capabilities: [MobileCapability] = [.conversationSyncV1, .chatResumeV1],
    gatewayID: String = "gateway-verified",
    publicKey: String = "public-key-verified"
  ) {
    self.recorder = recorder
    self.status = status
    self.apiVersion = apiVersion
    self.capabilities = capabilities
    self.gatewayID = gatewayID
    self.publicKey = publicKey
  }

  func health() async throws -> HealthResponse {
    await recorder.append(.health)
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

  func identity() async throws -> GatewayIdentityDTO {
    await recorder.append(.identity)
    return GatewayIdentityDTO(gatewayId: gatewayID, publicKey: publicKey)
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
  case activation
}

private actor RecordingPairingKeychain: KeychainStoring {
  let recorder: PairingCallRecorder
  let shouldFailSave: Bool
  let pauseAfterFirstSave: TestGate?
  private(set) var savedProfileIDs: [UUID] = []
  private(set) var savedSecrets: [ConnectionSecrets] = []
  private(set) var deletedProfileIDs: [UUID] = []
  private(set) var storedSecrets: [UUID: ConnectionSecrets]

  init(
    recorder: PairingCallRecorder,
    saveError: (any Error)? = nil,
    initialSecrets: [UUID: ConnectionSecrets] = [:],
    pauseAfterFirstSave: TestGate? = nil
  ) {
    self.recorder = recorder
    shouldFailSave = saveError != nil
    storedSecrets = initialSecrets
    self.pauseAfterFirstSave = pauseAfterFirstSave
  }

  func save(_ secrets: ConnectionSecrets, for profileID: UUID) async throws {
    savedProfileIDs.append(profileID)
    savedSecrets.append(secrets)
    await recorder.append(.keychainSave)
    if shouldFailSave {
      throw PairingTestError.save
    }
    storedSecrets[profileID] = secrets
    if savedProfileIDs.count == 1, let pauseAfterFirstSave {
      await pauseAfterFirstSave.wait()
    }
  }

  func load(for profileID: UUID) async throws -> ConnectionSecrets? {
    storedSecrets[profileID]
  }

  func delete(for profileID: UUID) async throws {
    deletedProfileIDs.append(profileID)
    storedSecrets[profileID] = nil
    await recorder.append(.keychainDelete)
  }
}

private actor RecordingPairingMetadata: PairingMetadataStoring {
  let recorder: PairingCallRecorder
  let shouldFail: Bool
  let existingProfile: ConnectionProfileSnapshot?
  let pauseAfterFirstSave: TestGate?
  private(set) var savedGatewayIDs: [String] = []
  private(set) var savedPublicKeys: [String] = []
  private(set) var savedProfiles: [ConnectionProfile] = []

  init(
    recorder: PairingCallRecorder,
    saveError: (any Error)? = nil,
    existingProfile: ConnectionProfileSnapshot? = nil,
    pauseAfterFirstSave: TestGate? = nil
  ) {
    self.recorder = recorder
    shouldFail = saveError != nil
    self.existingProfile = existingProfile
    self.pauseAfterFirstSave = pauseAfterFirstSave
  }

  func existingPairingProfile(gatewayID: String) async throws -> ConnectionProfileSnapshot? {
    guard existingProfile?.gatewayID == gatewayID else { return nil }
    return existingProfile
  }

  func savePairingProfile(
    _ profile: ConnectionProfile,
    identity: GatewayIdentityDTO
  ) async throws {
    savedGatewayIDs.append(identity.gatewayId)
    savedProfiles.append(profile)
    if let publicKey = profile.publicKey {
      savedPublicKeys.append(publicKey)
    }
    await recorder.append(.metadataSave)
    if shouldFail {
      throw PairingTestError.save
    }
    if savedProfiles.count == 1, let pauseAfterFirstSave {
      await pauseAfterFirstSave.wait()
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
  func install(_ pairing: VerifiedPairing) async throws -> ConnectionProfileSnapshot {
    pairing.profile
  }
}

private actor RecordingPairingInstaller: PairingProfileInstalling {
  private(set) var installCallCount = 0

  func install(_ pairing: VerifiedPairing) async throws -> ConnectionProfileSnapshot {
    installCallCount += 1
    return pairing.profile
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

private final class RecordingPreviewRotationConnection: QRScannerPreviewRotating {
  let supportedAngles: Set<CGFloat>
  var videoRotationAngle: CGFloat = 0 {
    didSet { appliedAngles.append(videoRotationAngle) }
  }
  private(set) var appliedAngles: [CGFloat] = []

  init(supportedAngles: Set<CGFloat>) {
    self.supportedAngles = supportedAngles
  }

  func isVideoRotationAngleSupported(_ angle: CGFloat) -> Bool {
    supportedAngles.contains(angle)
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

private actor FailThenBlockPairingEngineFactory {
  let retryGate: TestGate
  let retryEngine: PairingSyncEngine
  private var callCount = 0

  init(retryGate: TestGate, retryEngine: PairingSyncEngine) {
    self.retryGate = retryGate
    self.retryEngine = retryEngine
  }

  func make(_ profile: ConnectionProfileSnapshot) async throws -> any AppSyncing {
    _ = profile
    callCount += 1
    guard callCount > 1 else { throw PairingTestError.activation }
    await retryGate.wait()
    return retryEngine
  }
}

@MainActor
private final class PairingAnnouncementRecorder {
  var values: [String] = []
}

private func lanPayload() -> PairingPayload {
  PairingPayload(
    v: 3,
    host: "gateway.local",
    mgmtToken: "mobile-token",
    chatToken: "mobile-token",
    mgmtPort: 9400,
    chatPort: 9400,
    label: "Home",
    secure: true,
    relayCredential: nil,
    tlsCertificateSha256:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  )
}

private func relayPayload() -> PairingPayload {
  PairingPayload(
    v: 2,
    host: "relay.example",
    mgmtToken: "mobile-token-2",
    chatToken: "mobile-token-2",
    mgmtPort: nil,
    chatPort: nil,
    label: nil,
    secure: true,
    relayCredential: "relay-credential",
    tlsCertificateSha256: nil
  )
}

private func existingPairingProfile(id: UUID) -> ConnectionProfileSnapshot {
  ConnectionProfileSnapshot(
    gatewayID: "gateway-verified",
    profile: ConnectionProfile(
      id: id,
      gatewayId: "gateway-verified",
      publicKey: "old-public-key",
      label: "Old gateway",
      host: "old-gateway.local",
      managementPort: 9300,
      chatPort: 9200,
      secure: false,
      mode: .lan,
      createdAt: Date(timeIntervalSince1970: 10),
      lastSuccessfulSyncAt: Date(timeIntervalSince1970: 20)
    )
  )
}

private func verifiedPairing(id: UUID, secrets: ConnectionSecrets) -> VerifiedPairing {
  let identity = GatewayIdentityDTO(
    gatewayId: "gateway-verified",
    publicKey: "new-public-key"
  )
  return VerifiedPairing(
    profile: ConnectionProfileSnapshot(
      gatewayID: identity.gatewayId,
      profile: ConnectionProfile(
        id: id,
        gatewayId: identity.gatewayId,
        publicKey: identity.publicKey,
        label: "Updated gateway",
        host: "new-gateway.local",
        managementPort: 9301,
        chatPort: 9201,
        secure: true,
        mode: .lan,
        tlsCertificateSha256:
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        createdAt: Date(timeIntervalSince1970: 30),
        lastSuccessfulSyncAt: nil
      )
    ),
    identity: identity,
    secrets: secrets
  )
}
