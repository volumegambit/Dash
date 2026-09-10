import Foundation

enum MobileProtocolSelection: Equatable, Sendable {
  case v1
  case v2Queue

  var pathVersion: String {
    switch self {
    case .v1:
      "v1"
    case .v2Queue:
      "v2"
    }
  }
}

struct MobileProtocolNegotiation: Equatable, Sendable {
  let selection: MobileProtocolSelection
  let identity: GatewayIdentityDTO
}

protocol MobileProtocolNegotiating: Sendable {
  func negotiate() async throws -> MobileProtocolNegotiation
}

struct MobileProtocolNegotiator: MobileProtocolNegotiating {
  let makeAPI: @Sendable (MobileProtocolSelection) -> GatewayAPI

  init(_ makeAPI: @escaping @Sendable (MobileProtocolSelection) -> GatewayAPI) {
    self.makeAPI = makeAPI
  }

  func negotiate() async throws -> MobileProtocolNegotiation {
    let v2 = makeAPI(.v2Queue)
    let health: MobileV2HealthResponse
    do {
      health = try await v2.healthV2()
    } catch GatewayError.notFound {
      await v2.shutdown()
      return try await negotiateV1()
    } catch GatewayError.mobileVersionCapabilityRequired {
      await v2.shutdown()
      return try await negotiateV1()
    } catch {
      await v2.shutdown()
      throw error
    }

    do {
      guard health.status == "healthy" else { throw GatewayError.gatewayOffline }
      guard health.apiVersion == 2 else { throw GatewayError.updateRequired }
      guard health.pid > 0, health.agents >= 0, health.channels >= 0 else {
        throw GatewayError.updateRequired
      }
      guard Set(health.capabilities).count == health.capabilities.count else {
        throw GatewayError.updateRequired
      }
      guard health.capabilities.contains("chat-input-queue-v1") else {
        throw GatewayError.capabilityRequired
      }
      let result = MobileProtocolNegotiation(
        selection: .v2Queue,
        identity: try await v2.identityV2()
      )
      await v2.shutdown()
      return result
    } catch {
      await v2.shutdown()
      throw error
    }
  }

  private func negotiateV1() async throws -> MobileProtocolNegotiation {
    let v1 = makeAPI(.v1)
    do {
      let health = try await v1.health()
      guard health.status == "healthy" else { throw GatewayError.gatewayOffline }
      guard health.apiVersion == 1 else { throw GatewayError.updateRequired }
      let capabilities = Set(health.capabilities)
      guard capabilities.contains(.conversationSyncV1), capabilities.contains(.chatResumeV1) else {
        throw GatewayError.capabilityRequired
      }
      let result = MobileProtocolNegotiation(selection: .v1, identity: try await v1.identity())
      await v1.shutdown()
      return result
    } catch {
      await v1.shutdown()
      throw error
    }
  }
}
