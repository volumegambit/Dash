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

  func verify(
    profile: ConnectionProfileSnapshot,
    secrets: ConnectionSecrets
  ) async throws {
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
    } catch {
      await gateway.shutdown()
      throw error
    }
  }
}
