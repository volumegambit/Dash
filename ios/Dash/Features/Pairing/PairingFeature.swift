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

#if DEBUG
  extension VerifiedPairing {
    /// See `ConnectionProfile.applyingDebugRelayPortOverride`. `PairingVerifier`
    /// already bakes the override in before its own network calls, so a
    /// `VerifiedPairing` it returns already carries it — this exists so
    /// `AccountConnectFeature` can apply the SAME override defensively to
    /// whatever `VerifiedPairing` it receives, regardless of which
    /// `PairingVerifying` conformer produced it. Never compiled into Release.
    func applyingDebugRelayPortOverride(_ port: Int) -> VerifiedPairing {
      VerifiedPairing(
        profile: ConnectionProfileSnapshot(
          gatewayID: profile.gatewayID,
          profile: profile.profile.applyingDebugRelayPortOverride(port)
        ),
        identity: identity,
        secrets: secrets
      )
    }
  }
#endif

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
  #if DEBUG
    /// See `ConnectionProfile.applyingDebugRelayPortOverride` — applied right
    /// after `PairingPayload.validated()` so it's in effect for every network
    /// call this method makes (health/identity/agents/chat probe), not just
    /// the profile this returns. `validated()` itself is never touched.
    private let debugRelayPortOverride: Int?
  #endif

  init(
    makeGateway: @escaping @Sendable (
      ConnectionEndpoint,
      ConnectionSecrets
    ) -> any PairingGatewayChecking,
    makeChat: @escaping @Sendable (ConnectionEndpoint) -> any PairingChatChecking,
    makeProfileID: @escaping @Sendable () -> UUID = UUID.init,
    debugRelayPortOverride: Int? = nil
  ) {
    self.makeGateway = makeGateway
    self.makeChat = makeChat
    self.makeProfileID = makeProfileID
    #if DEBUG
      self.debugRelayPortOverride = debugRelayPortOverride
    #else
      _ = debugRelayPortOverride
    #endif
  }

  func verify(
    payload: PairingPayload,
    onStep: @escaping @MainActor @Sendable (PairingVerificationStep) -> Void
  ) async throws -> VerifiedPairing {
    let (validatedProfile, secrets) = try payload.validated(profileID: makeProfileID())
    #if DEBUG
      let rawProfile: ConnectionProfile
      if let debugRelayPortOverride, validatedProfile.mode == .relay {
        rawProfile = validatedProfile.applyingDebugRelayPortOverride(debugRelayPortOverride)
      } else {
        rawProfile = validatedProfile
      }
    #else
      let rawProfile = validatedProfile
    #endif
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
    guard
      identity.gatewayId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false,
      identity.publicKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    else {
      throw PairingValidationError.invalidGatewayIdentity
    }

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
  private enum State {
    case active
    case cancelled
    case committed
  }

  private let lock = NSLock()
  private var state = State.active

  @discardableResult
  func cancel() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard state != .committed else { return false }
    state = .cancelled
    return true
  }

  func beginCommit() throws {
    try Task.checkCancellation()
    lock.lock()
    defer { lock.unlock() }
    guard state == .active else { throw CancellationError() }
    state = .committed
  }

  func check() throws {
    lock.lock()
    let currentState = state
    lock.unlock()
    if currentState == .committed {
      return
    }
    try Task.checkCancellation()
    if currentState == .cancelled {
      throw CancellationError()
    }
  }

  var hasCommitted: Bool {
    lock.lock()
    defer { lock.unlock() }
    return state == .committed
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
      try cancellation.beginCommit()
      try await metadata.savePairingProfile(
        installedPairing.profile.profile,
        identity: installedPairing.identity
      )
    } catch {
      try await rollbackKeychain(
        profileID: installedPairing.profile.id,
        previousSecrets: previousSecrets
      )
      if error is CancellationError || (Task.isCancelled && cancellation.hasCommitted == false) {
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

/// Drives the verify → install pipeline for an already-formed `PairingPayload`
/// — cancellably, with curated failure copy. QR/paste/manual entry (which
/// used to produce that payload and own this class's lifecycle) were retired
/// in Task 7 of the iOS account sign-in plan; account sign-in
/// (`AccountConnectFeature`) now reaches the same `PairingVerifying`/
/// `PairingProfileInstalling` machinery directly instead of through this
/// class. Retained, currently unreferenced by product UI, as a reusable
/// payload-driven orchestrator.
@MainActor
@Observable
final class PairingFeature {
  private(set) var state: PairingState = .idle

  @ObservationIgnored private let verifier: any PairingVerifying
  @ObservationIgnored private let installer: any PairingProfileInstalling
  @ObservationIgnored private let onPaired:
    @MainActor @Sendable (ConnectionProfileSnapshot) async throws -> Void
  @ObservationIgnored private let announceFailure: @MainActor @Sendable (PairingFailure) -> Void
  @ObservationIgnored private var activePairingID: UUID?
  @ObservationIgnored private var activePairingCancellation: PairingCancellation?

  init(
    verifier: any PairingVerifying,
    installer: any PairingProfileInstalling,
    onPaired: @escaping @MainActor @Sendable (ConnectionProfileSnapshot) async throws -> Void,
    announceFailure: @escaping @MainActor @Sendable (PairingFailure) -> Void = { failure in
      AccessibilityNotification.Announcement("\(failure.title). \(failure.message)").post()
    }
  ) {
    self.verifier = verifier
    self.installer = installer
    self.onPaired = onPaired
    self.announceFailure = announceFailure
  }

  func pair(payload: PairingPayload) async {
    guard state.isWorking == false else { return }
    let pairingID = UUID()
    let cancellation = PairingCancellation()
    activePairingID = pairingID
    activePairingCancellation = cancellation
    state = .validating
    do {
      try requireActivePairing(pairingID, cancellation: cancellation)
      try await pair(payload: payload, pairingID: pairingID, cancellation: cancellation)
    } catch {
      finishPairing(pairingID, cancellation: cancellation, with: error)
    }
  }

  func cancelPairing() {
    if let activePairingCancellation, activePairingCancellation.cancel() == false {
      return
    }
    activePairingCancellation = nil
    activePairingID = nil
    if state.isWorking {
      state = .idle
    }
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
    try requireActivePairing(pairingID, cancellation: cancellation)
    state = .verifying(.saving)
    let installedProfile = try await installer.install(pairing, cancellation: cancellation)
    try requireActivePairing(pairingID, cancellation: cancellation)
    if cancellation.hasCommitted {
      try await Task { @MainActor in
        try await self.onPaired(installedProfile)
      }.value
    } else {
      try await onPaired(installedProfile)
    }
    try requireActivePairing(pairingID, cancellation: cancellation)
    state = .paired(installedProfile)
    activePairingID = nil
    activePairingCancellation = nil
  }

  private func requireActivePairing(
    _ pairingID: UUID,
    cancellation: PairingCancellation
  ) throws {
    try cancellation.check()
    guard activePairingID == pairingID else {
      throw CancellationError()
    }
  }

  private func finishPairing(
    _ pairingID: UUID,
    cancellation: PairingCancellation,
    with error: Error
  ) {
    guard activePairingID == pairingID else { return }
    activePairingID = nil
    activePairingCancellation = nil
    if cancellation.hasCommitted == false,
      error is CancellationError || Task.isCancelled
    {
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
