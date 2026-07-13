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

  func savePairingProfile(
    _ profile: ConnectionProfile,
    identity: GatewayIdentityDTO
  ) async throws {
    try await store.upsertProfile(profile, identity: identity)
  }
}

protocol PairingProfileInstalling: Actor {
  func install(_ pairing: VerifiedPairing) async throws
}

actor UnavailablePairingInstaller: PairingProfileInstalling {
  func install(_ pairing: VerifiedPairing) async throws {
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

  func install(_ pairing: VerifiedPairing) async throws {
    do {
      try await keychain.save(pairing.secrets, for: pairing.profile.id)
    } catch {
      throw PairingInstallError.keychain
    }

    do {
      try await metadata.savePairingProfile(pairing.profile.profile, identity: pairing.identity)
    } catch {
      do {
        try await keychain.delete(for: pairing.profile.id)
      } catch {
        throw PairingInstallError.metadataRollback
      }
      throw PairingInstallError.metadata
    }
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
  var chatPort = ""
  var secure = false
  var managementToken = ""
  var chatToken = ""
  var relayCredential = ""

  func payload() throws -> PairingPayload {
    switch mode {
    case .lan:
      return PairingPayload(
        v: 1,
        host: host,
        mgmtToken: managementToken,
        chatToken: chatToken,
        mgmtPort: try port(managementPort, field: "mgmtPort"),
        chatPort: try port(chatPort, field: "chatPort"),
        label: nil,
        secure: secure,
        relayCredential: nil
      )
    case .relay:
      return PairingPayload(
        v: 2,
        host: host,
        mgmtToken: managementToken,
        chatToken: chatToken,
        mgmtPort: nil,
        chatPort: nil,
        label: nil,
        secure: true,
        relayCredential: relayCredential
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

  @ObservationIgnored private let verifier: any PairingVerifying
  @ObservationIgnored private let installer: any PairingProfileInstalling
  @ObservationIgnored private let scanner: any QRScanning
  @ObservationIgnored private let onPaired:
    @MainActor @Sendable (ConnectionProfileSnapshot) async -> Void
  @ObservationIgnored private let announceFailure: @MainActor @Sendable (PairingFailure) -> Void
  @ObservationIgnored private var activeScanID: UUID?

  init(
    verifier: any PairingVerifying,
    installer: any PairingProfileInstalling,
    scanner: any QRScanning = UnavailableQRScanner(),
    onPaired: @escaping @MainActor @Sendable (ConnectionProfileSnapshot) async -> Void,
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
    activeScanID = nil
    self.rawPayload = rawPayload
    state = .validating
    await scanner.stop()
    do {
      let payload = try ContractCoding.decoder().decode(
        PairingPayload.self,
        from: Data(rawPayload.utf8)
      )
      try await pair(payload: payload)
    } catch {
      fail(with: pairingFailure(for: error))
    }
  }

  func pair(manual: ManualPairingInput) async {
    guard state.isWorking == false else { return }
    activeScanID = nil
    state = .validating
    await scanner.stop()
    do {
      try await pair(payload: manual.payload())
    } catch {
      fail(with: pairingFailure(for: error))
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

  func stopScanning() async {
    activeScanID = nil
    await scanner.stop()
  }

  private func pair(payload: PairingPayload) async throws {
    let pairing = try await verifier.verify(payload: payload) { [weak self] step in
      self?.state = .verifying(step)
    }
    state = .verifying(.saving)
    try await installer.install(pairing)
    await onPaired(pairing.profile)
    state = .paired(pairing.profile)
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
