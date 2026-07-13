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
    let gateway = makeGateway(endpoint, secrets)
    do {
      let health = try await gateway.health()
      guard health.apiVersion == 1 else { throw GatewayError.updateRequired }
      let capabilities = Set(health.capabilities)
      guard
        capabilities.contains(.conversationSyncV1),
        capabilities.contains(.chatResumeV1)
      else {
        throw GatewayError.capabilityRequired
      }
      let identity = try await gateway.identity()
      guard
        identity.gatewayId == profile.gatewayID,
        identity.gatewayId == profile.profile.gatewayId,
        identity.publicKey == profile.profile.publicKey
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
