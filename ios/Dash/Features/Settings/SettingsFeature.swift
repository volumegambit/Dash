import Foundation
import Observation

enum SettingsDisconnectError: Error, Equatable, Sendable {
  case keychain
  case localCleanup
}

enum ConnectionSeverity: Equatable, Sendable {
  case ok
  case warning
  case error
}

@MainActor
@Observable
final class SettingsFeature {
  let identity: GatewayIdentityDTO
  let gatewayLabel: String
  let mode: ConnectionMode
  var connection: GatewayConnectionState
  var lastSuccessfulSyncAt: Date?
  var isReconnecting = false
  var isForgetting = false
  var error: String?

  var publicKeyFingerprint: String {
    let characters = Array(identity.publicKey)
    guard characters.count >= 12 else { return "Unavailable" }
    return "\(String(characters.prefix(6)))…\(String(characters.suffix(6)))"
  }

  var modeText: String {
    switch mode {
    case .lan: "LAN"
    case .relay: "Relay"
    }
  }

  var connectionText: String {
    switch connection {
    case .connecting: "Connecting"
    case .online: "Online"
    case .reconnecting: "Reconnecting"
    case .offline: "Offline"
    case .gatewayOffline: "Gateway offline"
    case .rateLimited: "Rate limited"
    case .repairRequired: "Session no longer authorized"
    case .updateRequired: "Update required"
    }
  }

  /// How much attention a connection state deserves (settings clarity
  /// 2026-09-05).
  ///
  /// The Status row rendered every state as the same secondary grey text as
  /// "Type" and "Last sync", so "Rate limited" and "Online" were
  /// indistinguishable at a glance — on the one screen whose whole purpose
  /// is answering "is my gateway reachable?". Severity is modelled here
  /// rather than as a `Color` so it can be unit-tested; the view maps it to
  /// a colour.
  var connectionSeverity: ConnectionSeverity {
    switch connection {
    case .online: .ok
    // Transient or self-resolving: the app is already retrying, and the
    // user has nothing to do but wait.
    case .connecting, .reconnecting, .offline, .gatewayOffline, .rateLimited: .warning
    // Terminal until the user acts — re-authorize, or update the app.
    case .repairRequired, .updateRequired: .error
    }
  }

  var connectionSystemImage: String {
    switch connection {
    case .online: "checkmark.circle.fill"
    case .connecting, .reconnecting: "arrow.triangle.2.circlepath"
    case .offline: "wifi.slash"
    case .gatewayOffline: "server.rack"
    case .rateLimited: "clock"
    case .repairRequired: "link.badge.plus"
    case .updateRequired: "arrow.down.app"
    }
  }

  /// The full public key, when there is one worth copying. `nil` mirrors
  /// `publicKeyFingerprint`'s "Unavailable" case so the view never offers to
  /// copy a key it refuses to show.
  var copyablePublicKey: String? {
    identity.publicKey.count >= 12 ? identity.publicKey : nil
  }

  var canReconnect: Bool {
    guard isReconnecting == false, isForgetting == false else { return false }
    return switch connection {
    case .online, .offline, .gatewayOffline:
      true
    case .connecting, .reconnecting, .rateLimited, .repairRequired, .updateRequired:
      false
    }
  }

  var reconnectButtonTitle: String {
    isReconnecting ? "Reconnecting" : "Reconnect"
  }

  /// Shown when the gateway no longer accepts this device's credentials.
  /// There is no QR/manual re-pair entry any more — the only way back is
  /// through the account gateway list, which needs the current connection
  /// dropped first, so the copy names both halves of that in order.
  static let reauthorizeMessage =
    "Sign in again from the gateway list, or Disconnect & Forget this gateway, then try again."

  var displayValues: String {
    [
      gatewayLabel,
      identity.gatewayId,
      publicKeyFingerprint,
      modeText,
      connectionText,
      lastSuccessfulSyncAt?.formatted(.iso8601) ?? "Never",
    ].joined(separator: "\n")
  }

  @ObservationIgnored private let reconnectAction: @MainActor @Sendable () async throws -> Void
  @ObservationIgnored private let disconnectAction: @MainActor @Sendable () async throws -> Void
  @ObservationIgnored private var reconnectTask: Task<Void, Error>?
  @ObservationIgnored private var reconnectID: UUID?

  init(
    profile: ConnectionProfileSnapshot,
    connection: GatewayConnectionState,
    lastSuccessfulSyncAt: Date?,
    reconnectAction: @escaping @MainActor @Sendable () async throws -> Void,
    disconnectAction: @escaping @MainActor @Sendable () async throws -> Void
  ) {
    identity = GatewayIdentityDTO(
      gatewayId: profile.gatewayID,
      publicKey: profile.profile.publicKey ?? ""
    )
    gatewayLabel = profile.profile.label
    mode = profile.profile.mode
    self.connection = connection
    self.lastSuccessfulSyncAt = lastSuccessfulSyncAt
    self.reconnectAction = reconnectAction
    self.disconnectAction = disconnectAction
  }

  func consume(_ snapshot: SyncSnapshot) {
    update(
      connection: snapshot.connection,
      lastSuccessfulSyncAt: snapshot.lastSuccessfulSyncAt
    )
  }

  func update(
    connection: GatewayConnectionState,
    lastSuccessfulSyncAt: Date?
  ) {
    self.connection = connection
    if let lastSuccessfulSyncAt {
      self.lastSuccessfulSyncAt = lastSuccessfulSyncAt
    }
  }

  func reconnect() async {
    guard canReconnect else { return }
    let operationID = UUID()
    let action = reconnectAction
    let operation = Task { try await action() }
    reconnectID = operationID
    reconnectTask = operation
    isReconnecting = true
    error = nil
    defer {
      if reconnectID == operationID {
        reconnectID = nil
        reconnectTask = nil
        isReconnecting = false
      }
    }
    do {
      try await withTaskCancellationHandler {
        try await operation.value
      } onCancel: {
        operation.cancel()
      }
    } catch is CancellationError {
      return
    } catch is AppDependencyError {
      error = Self.reauthorizeMessage
    } catch GatewayProfileVerificationError.identityMismatch {
      error = Self.reauthorizeMessage
    } catch GatewayError.unauthorized {
      error = Self.reauthorizeMessage
    } catch GatewayError.capabilityRequired, GatewayError.updateRequired {
      error = "Update Dash on this device and the gateway, then try again."
    } catch {
      self.error = "Dash couldn't reconnect. Check the gateway and try again."
    }
  }

  func prepareForShutdown() {
    reconnectTask?.cancel()
  }

  func shutdown() async {
    let operationID = reconnectID
    let operation = reconnectTask
    operation?.cancel()
    if let operation {
      _ = await operation.result
    }
    if reconnectID == operationID {
      reconnectTask = nil
      reconnectID = nil
      isReconnecting = false
    }
  }

  func disconnectAndForget(confirmed: Bool) async {
    guard confirmed, isForgetting == false else { return }
    isForgetting = true
    defer { isForgetting = false }
    if let reconnectTask {
      reconnectTask.cancel()
      _ = await reconnectTask.result
      self.reconnectTask = nil
      reconnectID = nil
      isReconnecting = false
    }
    error = nil
    do {
      try await disconnectAction()
    } catch SettingsDisconnectError.keychain {
      error = "Dash couldn't remove this gateway from Keychain. Try again."
    } catch SettingsDisconnectError.localCleanup {
      error = "The connection was removed, but Dash couldn't remove all cached gateway data."
    } catch is CancellationError {
      return
    } catch {
      self.error = "Dash couldn't disconnect from this gateway. Try again."
    }
  }
}
