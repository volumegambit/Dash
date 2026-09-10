import Foundation

protocol GatewayProfileChecking: Actor {
  func health() async throws -> HealthResponse
  func identity() async throws -> GatewayIdentityDTO
  func shutdown() async
}

extension GatewayAPI: GatewayProfileChecking {}

enum GatewayProfileVerificationError: Error, Equatable, Sendable {
  case identityMismatch
}

struct GatewayProfileVerifier: Sendable {
  private let makeGateway:
    @Sendable (ConnectionEndpoint, ConnectionSecrets) -> any GatewayProfileChecking

  init(
    makeGateway: @escaping @Sendable (
      ConnectionEndpoint,
      ConnectionSecrets
    ) -> any GatewayProfileChecking
  ) {
    self.makeGateway = makeGateway
  }

  /// Verifies the profile and RETURNS what the gateway said it can do.
  ///
  /// The capability set used to be checked here and discarded, which made
  /// every optional capability invisible to the rest of the app. `speech-v1`
  /// is the first one that comes and goes with the gateway's credentials, so
  /// the answer has to travel back to `AppModel` rather than being re-derived
  /// from a second `/health` call somewhere else.
  func verify(
    profile: ConnectionProfileSnapshot,
    secrets: ConnectionSecrets
  ) async throws -> Set<MobileCapability> {
    let endpoint = ConnectionEndpoint(profile: profile.profile, secrets: secrets)
    try endpoint.requireTrustedTransport()
    guard
      profile.gatewayID.isEmpty == false,
      profile.profile.gatewayId == profile.gatewayID,
      let pinnedPublicKey = profile.profile.publicKey,
      pinnedPublicKey.isEmpty == false
    else {
      throw GatewayProfileVerificationError.identityMismatch
    }
    let gateway = makeGateway(endpoint, secrets)
    do {
      try Task.checkCancellation()
      let health = try await gateway.health()
      try Task.checkCancellation()
      guard health.status == "healthy" else { throw GatewayError.gatewayOffline }
      guard health.apiVersion == 1 else { throw GatewayError.updateRequired }
      let capabilities = Set(health.capabilities)
      guard
        capabilities.contains(.conversationSyncV1),
        capabilities.contains(.chatResumeV1)
      else {
        throw GatewayError.capabilityRequired
      }
      let identity = try await gateway.identity()
      try Task.checkCancellation()
      guard
        identity.gatewayId.isEmpty == false,
        identity.publicKey.isEmpty == false,
        identity.gatewayId == profile.gatewayID,
        identity.publicKey == pinnedPublicKey
      else {
        throw GatewayProfileVerificationError.identityMismatch
      }
      await gateway.shutdown()
      return capabilities
    } catch {
      await gateway.shutdown()
      throw error
    }
  }
}
