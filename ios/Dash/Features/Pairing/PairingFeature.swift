import AVFoundation
import Accessibility
import Foundation
import Observation

protocol PairingGatewayChecking: Actor {
  func health() async throws -> HealthResponse
  func identity() async throws -> GatewayIdentityDTO
  func listAgents() async throws -> [RegisteredAgentDTO]
}

extension GatewayAPI: PairingGatewayChecking {}

protocol PairingChatChecking: Actor {
  func probeAuthentication() async throws
}

extension ChatConnection: PairingChatChecking {}

enum PairingVerificationStep: String, Equatable, Sendable {
  case reachability = "Checking gateway"
  case capabilities = "Checking compatibility"
  case identity = "Verifying identity"
  case agents = "Loading agents"
  case chat = "Checking chat"
  case saving = "Saving connection"
}

struct VerifiedPairing: Sendable {
  let profile: ConnectionProfileSnapshot
  let identity: GatewayIdentityDTO
  let secrets: ConnectionSecrets
}

protocol PairingVerifying: Sendable {
  func verify(
    payload: PairingPayload,
    onStep: @escaping @MainActor @Sendable (PairingVerificationStep) -> Void
  ) async throws -> VerifiedPairing
}

struct UnavailablePairingVerifier: PairingVerifying {
  func verify(
    payload: PairingPayload,
    onStep: @escaping @MainActor @Sendable (PairingVerificationStep) -> Void
  ) async throws -> VerifiedPairing {
    _ = payload
    await onStep(.reachability)
    throw GatewayError.transport("Pairing is unavailable")
  }
}

struct PairingVerifier: Sendable {
  private let makeGateway:
    @Sendable (ConnectionEndpoint, ConnectionSecrets) -> any PairingGatewayChecking
  private let makeChat: @Sendable (ConnectionEndpoint) -> any PairingChatChecking
  private let makeProfileID: @Sendable () -> UUID

  init(
    makeGateway: @escaping @Sendable (
      ConnectionEndpoint,
      ConnectionSecrets
    ) -> any PairingGatewayChecking,
    makeChat: @escaping @Sendable (ConnectionEndpoint) -> any PairingChatChecking,
    makeProfileID: @escaping @Sendable () -> UUID = UUID.init
  ) {
    self.makeGateway = makeGateway
    self.makeChat = makeChat
    self.makeProfileID = makeProfileID
  }

  func verify(
    payload: PairingPayload,
    onStep: @escaping @MainActor @Sendable (PairingVerificationStep) -> Void
  ) async throws -> VerifiedPairing {
    let (rawProfile, secrets) = try payload.validated(profileID: makeProfileID())
    let endpoint = ConnectionEndpoint(profile: rawProfile, secrets: secrets)
    let gateway = makeGateway(endpoint, secrets)

    await onStep(.reachability)
    let health = try await gateway.health()
    guard health.status == "healthy" else { throw GatewayError.gatewayOffline }
    guard health.apiVersion == 1 else { throw GatewayError.updateRequired }

    await onStep(.capabilities)
    let capabilities = Set(health.capabilities)
    guard capabilities.contains(.conversationSyncV1), capabilities.contains(.chatResumeV1) else {
      throw GatewayError.capabilityRequired
    }

    await onStep(.identity)
    let identity = try await gateway.identity()

    await onStep(.agents)
    _ = try await gateway.listAgents()

    await onStep(.chat)
    try await makeChat(endpoint).probeAuthentication()

    var profile = rawProfile
    profile.gatewayId = identity.gatewayId
    profile.publicKey = identity.publicKey
    return VerifiedPairing(
      profile: ConnectionProfileSnapshot(gatewayID: identity.gatewayId, profile: profile),
      identity: identity,
      secrets: secrets
    )
  }
}

extension PairingVerifier: PairingVerifying {}

protocol PairingMetadataStoring: Actor {
  func existingPairingProfile(gatewayID: String) async throws -> ConnectionProfileSnapshot?
  func savePairingProfile(
    _ profile: ConnectionProfile,
    identity: GatewayIdentityDTO
  ) async throws
}

actor PersistencePairingMetadataStore: PairingMetadataStoring {
  private let store: PersistenceStore

  init(store: PersistenceStore) {
    self.store = store
  }

  func existingPairingProfile(gatewayID: String) async throws -> ConnectionProfileSnapshot? {
    try await store.profile(gatewayID: gatewayID)
  }

  func savePairingProfile(
    _ profile: ConnectionProfile,
    identity: GatewayIdentityDTO
  ) async throws {
    try await store.upsertProfile(profile, identity: identity)
  }
}

protocol PairingProfileInstalling: Actor {
  func install(_ pairing: VerifiedPairing) async throws -> ConnectionProfileSnapshot
  func install(
    _ pairing: VerifiedPairing,
    cancellation: PairingCancellation
  ) async throws -> ConnectionProfileSnapshot
}

extension PairingProfileInstalling {
  func install(
    _ pairing: VerifiedPairing,
    cancellation: PairingCancellation
  ) async throws -> ConnectionProfileSnapshot {
    try cancellation.check()
    let installed = try await install(pairing)
    try cancellation.check()
    return installed
  }
}

final class PairingCancellation: @unchecked Sendable {
  private let lock = NSLock()
  private var isCancelled = false

  func cancel() {
    lock.lock()
    isCancelled = true
    lock.unlock()
  }

  func check() throws {
    try Task.checkCancellation()
    lock.lock()
    let cancelled = isCancelled
    lock.unlock()
    if cancelled {
      throw CancellationError()
    }
  }
}

actor UnavailablePairingInstaller: PairingProfileInstalling {
  func install(_ pairing: VerifiedPairing) async throws -> ConnectionProfileSnapshot {
    _ = pairing
    throw PairingInstallError.metadata
  }
}

enum PairingInstallError: Error, Sendable {
  case keychain
  case metadata
  case metadataRollback
}

actor PairingProfileInstaller: PairingProfileInstalling {
  private let keychain: any KeychainStoring
  private let metadata: any PairingMetadataStoring

  init(keychain: any KeychainStoring, metadata: any PairingMetadataStoring) {
    self.keychain = keychain
    self.metadata = metadata
  }

  func install(_ pairing: VerifiedPairing) async throws -> ConnectionProfileSnapshot {
    try await install(pairing, cancellation: PairingCancellation())
  }

  func install(
    _ pairing: VerifiedPairing,
    cancellation: PairingCancellation
  ) async throws -> ConnectionProfileSnapshot {
    try cancellation.check()
    let existing: ConnectionProfileSnapshot?
    do {
      existing = try await metadata.existingPairingProfile(
        gatewayID: pairing.profile.gatewayID
      )
    } catch {
      throw PairingInstallError.metadata
    }

    let installedPairing = pairing.reusingProfileMetadata(from: existing)
    let previousSecrets: ConnectionSecrets?
    if let existing {
      do {
        previousSecrets = try await keychain.load(for: existing.id)
      } catch {
        throw PairingInstallError.keychain
      }
    } else {
      previousSecrets = nil
    }

    do {
      try cancellation.check()
      try await keychain.save(installedPairing.secrets, for: installedPairing.profile.id)
    } catch {
      if error is CancellationError || Task.isCancelled {
        try await rollbackKeychain(
          profileID: installedPairing.profile.id,
          previousSecrets: previousSecrets
        )
        throw CancellationError()
      }
      throw PairingInstallError.keychain
    }

    do {
      try cancellation.check()
      try await metadata.savePairingProfile(
        installedPairing.profile.profile,
        identity: installedPairing.identity
      )
    } catch {
      try await rollbackKeychain(
        profileID: installedPairing.profile.id,
        previousSecrets: previousSecrets
      )
      if error is CancellationError || Task.isCancelled {
        throw CancellationError()
      }
      throw PairingInstallError.metadata
    }
    return installedPairing.profile
  }

  private func rollbackKeychain(
    profileID: UUID,
    previousSecrets: ConnectionSecrets?
  ) async throws {
    do {
      if let previousSecrets {
        try await keychain.save(previousSecrets, for: profileID)
      } else {
        try await keychain.delete(for: profileID)
      }
    } catch {
      throw PairingInstallError.metadataRollback
    }
  }
}

extension VerifiedPairing {
  fileprivate func reusingProfileMetadata(
    from existing: ConnectionProfileSnapshot?
  ) -> VerifiedPairing {
    guard let existing else { return self }
    let proposed = profile.profile
    let canonical = ConnectionProfile(
      id: existing.id,
      gatewayId: proposed.gatewayId,
      publicKey: proposed.publicKey,
      label: proposed.label,
      host: proposed.host,
      managementPort: proposed.managementPort,
      chatPort: proposed.chatPort,
      secure: proposed.secure,
      mode: proposed.mode,
      tlsCertificateSha256: proposed.tlsCertificateSha256,
      createdAt: existing.profile.createdAt,
      lastSuccessfulSyncAt: existing.profile.lastSuccessfulSyncAt
    )
    return VerifiedPairing(
      profile: ConnectionProfileSnapshot(gatewayID: profile.gatewayID, profile: canonical),
      identity: identity,
      secrets: secrets
    )
  }
}

struct PairingFailure: Equatable, Sendable {
  let title: String
  let message: String
}

enum ManualPairingMode: String, CaseIterable, Identifiable, Sendable {
  case lan
  case relay

  var id: Self { self }
}

struct ManualPairingInput: Equatable, Sendable {
  var mode: ManualPairingMode = .lan
  var host = ""
  var managementPort = ""
  var mobileToken = ""
  var relayCredential = ""
  var tlsCertificateSha256 = ""

  func payload() throws -> PairingPayload {
    switch mode {
    case .lan:
      let lanPort = try port(managementPort, field: "mgmtPort") ?? 9400
      return PairingPayload(
        v: 3,
        host: host,
        mgmtToken: mobileToken,
        chatToken: mobileToken,
        mgmtPort: lanPort,
        chatPort: lanPort,
        label: nil,
        secure: true,
        relayCredential: nil,
        tlsCertificateSha256: tlsCertificateSha256
      )
    case .relay:
      return PairingPayload(
        v: 2,
        host: host,
        mgmtToken: mobileToken,
        chatToken: mobileToken,
        mgmtPort: nil,
        chatPort: nil,
        label: nil,
        secure: true,
        relayCredential: relayCredential,
        tlsCertificateSha256: nil
      )
    }
  }

  private func port(_ value: String, field: String) throws -> Int? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.isEmpty == false else { return nil }
    guard let value = Int(trimmed), (1...65_535).contains(value) else {
      throw PairingValidationError.invalidPort(field)
    }
    return value
  }
}

enum PairingState: Equatable, Sendable {
  case idle
  case validating
  case verifying(PairingVerificationStep)
  case failed(PairingFailure)
  case paired(ConnectionProfileSnapshot)

  var isWorking: Bool {
    switch self {
    case .validating, .verifying:
      true
    case .idle, .failed, .paired:
      false
    }
  }
}

@MainActor
@Observable
final class PairingFeature {
  var rawPayload = ""
  private(set) var state: PairingState = .idle
  var cameraAuthorization: AVAuthorizationStatus = .notDetermined

  var canPastePairingCode: Bool { true }
  var canEnterManually: Bool { true }
  var scannerPreviewSource: QRScannerPreviewSource? { scanner.previewSource }

  @ObservationIgnored private let verifier: any PairingVerifying
  @ObservationIgnored private let installer: any PairingProfileInstalling
  @ObservationIgnored private let scanner: any QRScanning
  @ObservationIgnored private let onPaired:
    @MainActor @Sendable (ConnectionProfileSnapshot) async throws -> Void
  @ObservationIgnored private let announceFailure: @MainActor @Sendable (PairingFailure) -> Void
  @ObservationIgnored private var activeScanID: UUID?
  @ObservationIgnored private var activePairingID: UUID?
  @ObservationIgnored private var activePairingCancellation: PairingCancellation?

  init(
    verifier: any PairingVerifying,
    installer: any PairingProfileInstalling,
    scanner: any QRScanning = UnavailableQRScanner(),
    onPaired: @escaping @MainActor @Sendable (ConnectionProfileSnapshot) async throws -> Void,
    announceFailure: @escaping @MainActor @Sendable (PairingFailure) -> Void = { failure in
      AccessibilityNotification.Announcement("\(failure.title). \(failure.message)").post()
    }
  ) {
    self.verifier = verifier
    self.installer = installer
    self.scanner = scanner
    self.onPaired = onPaired
    self.announceFailure = announceFailure
  }

  func pair(rawPayload: String) async {
    guard state.isWorking == false else { return }
    let pairingID = UUID()
    let cancellation = PairingCancellation()
    activePairingID = pairingID
    activePairingCancellation = cancellation
    activeScanID = nil
    self.rawPayload = rawPayload
    state = .validating
    await scanner.stop()
    do {
      try requireActivePairing(pairingID)
      let payload = try ContractCoding.decoder().decode(
        PairingPayload.self,
        from: Data(rawPayload.utf8)
      )
      try await pair(payload: payload, pairingID: pairingID, cancellation: cancellation)
    } catch {
      finishPairing(pairingID, with: error)
    }
  }

  func pair(manual: ManualPairingInput) async {
    guard state.isWorking == false else { return }
    let pairingID = UUID()
    let cancellation = PairingCancellation()
    activePairingID = pairingID
    activePairingCancellation = cancellation
    activeScanID = nil
    state = .validating
    await scanner.stop()
    do {
      try requireActivePairing(pairingID)
      try await pair(
        payload: manual.payload(),
        pairingID: pairingID,
        cancellation: cancellation
      )
    } catch {
      finishPairing(pairingID, with: error)
    }
  }

  func requestCameraAndScan() async {
    let scanID = UUID()
    activeScanID = scanID
    var authorization = await scanner.authorizationStatus()
    guard activeScanID == scanID else { return }
    cameraAuthorization = authorization
    if authorization == .notDetermined {
      _ = await scanner.requestAccess()
      guard activeScanID == scanID else { return }
      authorization = await scanner.authorizationStatus()
      guard activeScanID == scanID else { return }
      cameraAuthorization = authorization
    }
    guard authorization == .authorized else {
      activeScanID = nil
      return
    }
    do {
      let payload = try await scanner.scan()
      try Task.checkCancellation()
      guard activeScanID == scanID else { return }
      activeScanID = nil
      await pair(rawPayload: payload)
    } catch is CancellationError {
      if activeScanID == scanID {
        activeScanID = nil
      }
      return
    } catch QRScannerError.stopped {
      if activeScanID == scanID {
        activeScanID = nil
      }
      return
    } catch {
      guard activeScanID == scanID else { return }
      activeScanID = nil
      fail(
        with:
          PairingFailure(
            title: "Couldn't scan code",
            message: "Keep the code in the frame, or paste it instead."
          )
      )
    }
  }

  func invalidateScanning() {
    activeScanID = nil
  }

  func cancelPairing() {
    activeScanID = nil
    activePairingCancellation?.cancel()
    activePairingCancellation = nil
    activePairingID = nil
    if state.isWorking {
      state = .idle
    }
  }

  func stopScanning() async {
    invalidateScanning()
    await scanner.stop()
  }

  private func pair(
    payload: PairingPayload,
    pairingID: UUID,
    cancellation: PairingCancellation
  ) async throws {
    let pairing = try await verifier.verify(payload: payload) { [weak self] step in
      guard self?.activePairingID == pairingID else { return }
      self?.state = .verifying(step)
    }
    try requireActivePairing(pairingID)
    state = .verifying(.saving)
    let installedProfile = try await installer.install(pairing, cancellation: cancellation)
    try requireActivePairing(pairingID)
    try await onPaired(installedProfile)
    try requireActivePairing(pairingID)
    state = .paired(installedProfile)
    activePairingID = nil
    activePairingCancellation = nil
  }

  private func requireActivePairing(_ pairingID: UUID) throws {
    try Task.checkCancellation()
    guard activePairingID == pairingID else {
      throw CancellationError()
    }
  }

  private func finishPairing(_ pairingID: UUID, with error: Error) {
    guard activePairingID == pairingID else { return }
    activePairingID = nil
    activePairingCancellation = nil
    if error is CancellationError || Task.isCancelled {
      state = .idle
      return
    }
    fail(with: pairingFailure(for: error))
  }

  private func pairingFailure(for error: Error) -> PairingFailure {
    if error is PairingInstallError {
      return PairingFailure(
        title: "Couldn't save connection",
        message: "Your gateway was verified, but Dash couldn't save it on this device. Try again."
      )
    }
    if error is PairingValidationError || error is DecodingError {
      return PairingFailure(
        title: "Invalid connection details",
        message: "Check the gateway address, ports, and connection values, then try again."
      )
    }
    if let error = error as? GatewayError {
      switch error {
      case .unauthorized:
        return PairingFailure(
          title: "Re-pair this device",
          message: "The gateway rejected these credentials. Scan a fresh pairing code."
        )
      case .capabilityRequired:
        return PairingFailure(
          title: "Update Dash",
          message: "This gateway does not support mobile conversation sync yet."
        )
      case .updateRequired:
        return PairingFailure(
          title: "Update Dash",
          message: "Update Dash on this device and the gateway to compatible versions."
        )
      case .gatewayOffline:
        return PairingFailure(
          title: "Gateway offline",
          message: "The relay cannot reach this gateway. Check Mission Control and try again."
        )
      case .transport:
        return PairingFailure(
          title: "Gateway offline",
          message: "Make sure the gateway is running and reachable, then try again."
        )
      case .rateLimited(let retryAfter):
        return PairingFailure(
          title: "Too many requests",
          message: retryMessage(for: retryAfter)
        )
      case .notFound, .validation, .revisionConflict, .conversationBusy,
        .mutationOutcomeUnknown, .server:
        break
      }
    }
    return PairingFailure(
      title: "Couldn't connect",
      message: "Check the pairing code and gateway, then try again."
    )
  }

  private func fail(with failure: PairingFailure) {
    state = .failed(failure)
    announceFailure(failure)
  }

  private func retryMessage(for duration: Duration?) -> String {
    guard let duration else { return "Try again in a moment." }
    let components = duration.components
    let seconds = components.seconds + (components.attoseconds > 0 ? 1 : 0)
    return "Try again in \(max(0, seconds)) seconds."
  }
}
