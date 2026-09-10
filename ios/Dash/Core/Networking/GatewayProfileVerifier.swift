import Foundation

enum GatewayProfileVerificationError: Error, Equatable, Sendable {
  case identityMismatch
}

struct GatewayProfileVerifier: Sendable {
  private let makeNegotiator:
    @Sendable (ConnectionEndpoint, ConnectionSecrets) -> any MobileProtocolNegotiating

  init(
    makeNegotiator: @escaping @Sendable (
      ConnectionEndpoint,
      ConnectionSecrets
    ) -> any MobileProtocolNegotiating
  ) {
    self.makeNegotiator = makeNegotiator
  }

  func verify(
    profile: ConnectionProfileSnapshot,
    secrets: ConnectionSecrets
  ) async throws -> MobileProtocolNegotiation {
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
    try Task.checkCancellation()
    let negotiation = try await makeNegotiator(endpoint, secrets).negotiate()
    try Task.checkCancellation()
    guard
      negotiation.identity.gatewayId.isEmpty == false,
      negotiation.identity.publicKey.isEmpty == false,
      negotiation.identity.gatewayId == profile.gatewayID,
      negotiation.identity.publicKey == pinnedPublicKey
    else {
      throw GatewayProfileVerificationError.identityMismatch
    }
    return negotiation
  }
}
