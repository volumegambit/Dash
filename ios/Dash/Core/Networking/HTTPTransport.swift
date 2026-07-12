import Foundation

struct GatewayRequest: Sendable {
  enum Method: String, Sendable {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case patch = "PATCH"
    case delete = "DELETE"

    var isMutation: Bool {
      self != .get
    }
  }

  let method: Method
  let path: [String]
  let query: [URLQueryItem]
  let resourceID: String?
  let requestID: String?

  init(
    method: Method,
    path: [String],
    query: [URLQueryItem] = [],
    resourceID: String? = nil,
    requestID: String? = nil
  ) {
    self.method = method
    self.path = path
    self.query = query
    self.resourceID = resourceID
    self.requestID = requestID
  }
}

actor HTTPTransport {
  private let endpoint: ConnectionEndpoint
  private let secrets: ConnectionSecrets
  private let session: URLSession
  private let clock: any AppClock

  init(
    endpoint: ConnectionEndpoint,
    secrets: ConnectionSecrets,
    session: URLSession = .shared,
    clock: any AppClock = SystemAppClock()
  ) {
    self.endpoint = endpoint
    self.secrets = secrets
    self.session = session
    self.clock = clock
  }

  func send<Response: Decodable>(
    _ request: GatewayRequest,
    body: (any Encodable & Sendable)? = nil,
    ifMatch: Int? = nil
  ) async throws -> sending Response {
    let (data, _) = try await perform(request, body: body, ifMatch: ifMatch)
    guard data.isEmpty == false else {
      throw GatewayError.updateRequired
    }
    do {
      return try ContractCoding.decoder().decode(Response.self, from: data)
    } catch is DecodingError {
      throw GatewayError.updateRequired
    } catch is ContractValidationError {
      throw GatewayError.updateRequired
    }
  }

  func sendEmpty(
    _ request: GatewayRequest,
    body: (any Encodable & Sendable)? = nil,
    ifMatch: Int? = nil
  ) async throws {
    let (data, _) = try await perform(request, body: body, ifMatch: ifMatch)
    guard data.isEmpty else {
      throw GatewayError.updateRequired
    }
  }

  private func perform(
    _ descriptor: GatewayRequest,
    body: (any Encodable & Sendable)?,
    ifMatch: Int?
  ) async throws -> (Data, HTTPURLResponse) {
    var request = URLRequest(url: try url(for: descriptor))
    request.httpMethod = descriptor.method.rawValue
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if descriptor.path != ["mobile", "v1", "health"] {
      request.setValue(
        "Bearer \(secrets.managementToken)",
        forHTTPHeaderField: "Authorization"
      )
    }
    if endpoint.profile.mode == .relay, let relayCredential = secrets.relayCredential {
      request.setValue(relayCredential, forHTTPHeaderField: "x-dash-relay-credential")
    }
    if let body {
      request.httpBody = try ContractCoding.encoder().encode(body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    if let ifMatch {
      request.setValue("\"\(ifMatch)\"", forHTTPHeaderField: "If-Match")
    }

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw transportError(for: error, request: descriptor)
    }
    guard let httpResponse = response as? HTTPURLResponse else {
      throw GatewayError.transport("Gateway returned a non-HTTP response")
    }
    guard (200..<300).contains(httpResponse.statusCode) else {
      throw await mapHTTPError(response: httpResponse, data: data)
    }
    return (data, httpResponse)
  }

  private func url(for request: GatewayRequest) throws -> URL {
    let baseURL = try endpoint.managementURL(path: "/", query: [])
    guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
      throw URLError(.badURL)
    }
    var allowed = CharacterSet.urlPathAllowed
    allowed.remove(charactersIn: "/?#%")
    let encodedSegments = try request.path.map { segment -> String in
      guard let encoded = segment.addingPercentEncoding(withAllowedCharacters: allowed) else {
        throw URLError(.badURL)
      }
      return encoded
    }
    components.percentEncodedPath = "/" + encodedSegments.joined(separator: "/")
    components.queryItems = request.query.isEmpty ? nil : request.query
    guard let url = components.url else {
      throw URLError(.badURL)
    }
    return url
  }

  private func transportError(for error: Error, request: GatewayRequest) -> GatewayError {
    let nsError = error as NSError
    let isTimeout =
      (error as? URLError)?.code == .timedOut
      || (nsError.domain == NSURLErrorDomain && nsError.code == URLError.timedOut.rawValue)
    if isTimeout, request.method.isMutation {
      return .mutationOutcomeUnknown(
        resourceID: request.resourceID,
        requestID: request.requestID
      )
    }
    return .transport(error.localizedDescription)
  }

  private func mapHTTPError(response: HTTPURLResponse, data: Data) async -> GatewayError {
    let body = try? ContractCoding.decoder().decode(MobileAPIError.self, from: data)
    switch response.statusCode {
    case 401:
      return .unauthorized
    case 429:
      return .rateLimited(
        retryAfter: await retryAfter(response: response, body: body)
      )
    case 502 where endpoint.profile.mode == .relay:
      return .gatewayOffline
    case 404:
      return .notFound
    default:
      break
    }

    guard let body else {
      return .server(
        MobileAPIError(
          code: "http_\(response.statusCode)",
          error: HTTPURLResponse.localizedString(forStatusCode: response.statusCode),
          retryable: response.statusCode >= 500,
          details: nil
        ),
        status: response.statusCode
      )
    }
    switch body.code {
    case "not_found":
      return .notFound
    case "validation_failed":
      return .validation(body.error)
    case "capability_required":
      return .capabilityRequired
    case "revision_conflict":
      guard
        let current = try? decodeDetail(
          ConversationSummaryDTO.self,
          named: "current",
          from: body
        )
      else {
        return .updateRequired
      }
      return .revisionConflict(current: current)
    case "conversation_busy":
      guard case .string(let activeTurnID)? = body.details?.objectValue?["activeTurnId"] else {
        return .updateRequired
      }
      return .conversationBusy(activeTurnId: activeTurnID)
    default:
      return .server(body, status: response.statusCode)
    }
  }

  private func retryAfter(
    response: HTTPURLResponse,
    body: MobileAPIError?
  ) async -> Duration? {
    if let value = response.value(forHTTPHeaderField: "Retry-After") {
      if let seconds = Double(value), let duration = duration(seconds: seconds) {
        return duration
      }
      if let date = retryAfterDate(value) {
        let interval = max(0, date.timeIntervalSince(await clock.now()))
        return duration(seconds: interval)
      }
    }
    if case .number(let seconds)? = body?.details?.objectValue?["retryAfterSeconds"],
      let duration = duration(seconds: seconds)
    {
      return duration
    }
    return nil
  }

  private func retryAfterDate(_ value: String) -> Date? {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss zzz"
    return formatter.date(from: value)
  }

  private func duration(seconds: Double) -> Duration? {
    let milliseconds = (seconds * 1_000).rounded()
    guard milliseconds.isFinite, milliseconds >= 0, milliseconds < Double(Int64.max) else {
      return nil
    }
    return .milliseconds(Int64(milliseconds))
  }

  private func decodeDetail<Value: Decodable>(
    _ type: Value.Type,
    named name: String,
    from error: MobileAPIError
  ) throws -> Value {
    guard let value = error.details?.objectValue?[name] else {
      throw GatewayError.updateRequired
    }
    let data = try ContractCoding.encoder().encode(value)
    return try ContractCoding.decoder().decode(type, from: data)
  }
}
