import Foundation

enum GatewayInvalidationEvent: Equatable, Sendable {
  case conversationChanged(conversationID: String, revision: Int)
  case conversationDeleted(conversationID: String, revision: Int)
}

actor SSEClient {
  private let endpoint: ConnectionEndpoint
  private let secrets: ConnectionSecrets
  private let session: URLSession

  init(
    endpoint: ConnectionEndpoint,
    secrets: ConnectionSecrets,
    session: URLSession = .shared
  ) {
    self.endpoint = endpoint
    self.secrets = secrets
    self.session = session
  }

  func events() -> AsyncThrowingStream<GatewayInvalidationEvent, Error> {
    let endpoint = endpoint
    let secrets = secrets
    let session = session
    return AsyncThrowingStream { continuation in
      let worker = Task {
        do {
          try endpoint.requireTrustedTransport()
          var request = URLRequest(
            url: try endpoint.managementURL(path: "/mobile/v1/events", query: [])
          )
          request.httpMethod = "GET"
          request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
          request.setValue(
            "Bearer \(secrets.managementToken)",
            forHTTPHeaderField: "Authorization"
          )
          if endpoint.profile.mode == .relay, let relayCredential = secrets.relayCredential {
            request.setValue(relayCredential, forHTTPHeaderField: "x-dash-relay-credential")
          }

          let (bytes, response) = try await session.bytes(for: request)
          guard let httpResponse = response as? HTTPURLResponse else {
            throw GatewayError.transport("Gateway returned a non-HTTP SSE response")
          }
          guard (200..<300).contains(httpResponse.statusCode) else {
            throw mapSSEStatus(httpResponse.statusCode, relay: endpoint.profile.mode == .relay)
          }

          var parser = SSEParser()
          for try await byte in bytes {
            try Task.checkCancellation()
            if let event = try parser.append(byte) {
              continuation.yield(event)
            }
          }
          throw GatewayError.transport("SSE disconnected")
        } catch is DecodingError {
          continuation.finish(throwing: GatewayError.updateRequired)
        } catch is ContractValidationError {
          continuation.finish(throwing: GatewayError.updateRequired)
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { @Sendable _ in
        worker.cancel()
      }
    }
  }
}

private struct SSEParser {
  private struct Payload: Decodable {
    let type: String
    let conversationId: String
    let revision: Int
  }

  private var lineBuffer = Data()
  private var eventName: String?
  private var dataLines: [String] = []

  mutating func append(_ byte: UInt8) throws -> GatewayInvalidationEvent? {
    guard byte == 0x0A else {
      lineBuffer.append(byte)
      return nil
    }
    if lineBuffer.last == 0x0D {
      lineBuffer.removeLast()
    }
    guard let line = String(data: lineBuffer, encoding: .utf8) else {
      throw GatewayError.updateRequired
    }
    lineBuffer.removeAll(keepingCapacity: true)
    return try process(line)
  }

  private mutating func process(_ line: String) throws -> GatewayInvalidationEvent? {
    if line.isEmpty {
      defer {
        eventName = nil
        dataLines.removeAll(keepingCapacity: true)
      }
      return try dispatch()
    }
    if line.hasPrefix(":") {
      return nil
    }
    let pieces = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
    let field = String(pieces[0])
    var value = pieces.count == 2 ? String(pieces[1]) : ""
    if value.hasPrefix(" ") {
      value.removeFirst()
    }
    switch field {
    case "event":
      eventName = value
    case "data":
      dataLines.append(value)
    default:
      break
    }
    return nil
  }

  private func dispatch() throws -> GatewayInvalidationEvent? {
    guard let eventName,
      eventName == "conversation:changed" || eventName == "conversation:deleted"
    else {
      return nil
    }
    let data = Data(dataLines.joined(separator: "\n").utf8)
    let payload = try ContractCoding.decoder().decode(Payload.self, from: data)
    guard payload.type == eventName else {
      throw GatewayError.updateRequired
    }
    switch eventName {
    case "conversation:changed":
      return .conversationChanged(
        conversationID: payload.conversationId,
        revision: payload.revision
      )
    case "conversation:deleted":
      return .conversationDeleted(
        conversationID: payload.conversationId,
        revision: payload.revision
      )
    default:
      return nil
    }
  }
}

private func mapSSEStatus(_ status: Int, relay: Bool) -> GatewayError {
  switch status {
  case 401:
    return .unauthorized
  case 404:
    return .notFound
  case 426:
    return .capabilityRequired
  case 429:
    return .rateLimited(retryAfter: nil)
  case 502 where relay:
    return .gatewayOffline
  default:
    return .transport("SSE request failed with HTTP \(status)")
  }
}
