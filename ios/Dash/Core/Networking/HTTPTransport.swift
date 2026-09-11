import Foundation

/// The seven `SpeechErrorCode`s (`packages/speech/src/errors.ts`). `/speech/*`
/// reuses the shared `{ code, error, retryable }` envelope and passes these
/// through untranslated, so the CODE — not the status — is what identifies a
/// speech failure.
///
/// `unauthorized` is in the list deliberately. A provider's rejected key and
/// the gateway's own rejected bearer token are indistinguishable by code on
/// this namespace, and the trade-off runs one way only: showing a speech error
/// when the phone's token really expired costs a confusing message on one
/// screen, while the reverse sends the user to re-pair a device whose pairing
/// is fine. Every other route still maps a 401 to `.unauthorized`.
private let speechErrorCodes: Set<String> = [
  "unauthorized",
  "too_large",
  "too_long",
  "provider",
  "network",
  "unavailable",
  "invalid",
]

struct GatewayRequest: Sendable {
  /// Which error vocabulary a non-2xx on this request speaks. `/speech/*`
  /// answers with provider-level codes whose HTTP statuses collide with the
  /// gateway's own meanings; every other route is unaffected.
  enum ErrorScope: Sendable {
    case gateway
    case speech
  }

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
  let errorScope: ErrorScope

  init(
    method: Method,
    path: [String],
    query: [URLQueryItem] = [],
    resourceID: String? = nil,
    requestID: String? = nil,
    errorScope: ErrorScope = .gateway
  ) {
    self.method = method
    self.path = path
    self.query = query
    self.resourceID = resourceID
    self.requestID = requestID
    self.errorScope = errorScope
  }
}

/// A speech-scoped failure, or nil when the body is undecodable or carries a
/// code outside the speech vocabulary — in which case the caller falls through
/// to the ordinary status-first mapping unchanged.
private func speechError(from data: Data) -> GatewayError? {
  guard
    let body = try? ContractCoding.decoder().decode(MobileAPIError.self, from: data),
    speechErrorCodes.contains(body.code)
  else {
    return nil
  }
  return .speech(code: body.code, message: body.error, retryable: body.retryable)
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

  func shutdown() {
    session.invalidateAndCancel()
  }

  func send<Response: Decodable & Sendable>(
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

  /// The raw response body, for the one operation whose success payload is not
  /// JSON: `POST /speech/speech` streams `audio/mpeg`, or `audio/wav` for a
  /// PCM-only model. Identical to `send` apart from the `Accept` it asks for
  /// and the absence of a decode — in particular a non-2xx still goes through
  /// `perform`'s `mapHTTPError`, so a failed synthesis surfaces as a
  /// `GatewayError` rather than as error-page bytes handed back as if they
  /// were audio.
  ///
  /// No empty-body guard: audio is opaque, and a zero-byte 200 is a provider
  /// problem for the caller to notice, not a contract violation.
  func sendData(
    _ request: GatewayRequest,
    body: (any Encodable & Sendable)? = nil,
    accept: String
  ) async throws -> Data {
    let (data, _) = try await perform(request, body: body, ifMatch: nil, accept: accept)
    return data
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
    ifMatch: Int?,
    accept: String = "application/json"
  ) async throws -> (Data, HTTPURLResponse) {
    try endpoint.requireTrustedTransport()
    var request = URLRequest(url: try url(for: descriptor))
    request.httpMethod = descriptor.method.rawValue
    request.setValue(accept, forHTTPHeaderField: "Accept")
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
      let nsError = error as NSError
      if error is CancellationError
        || Task.isCancelled
        || (error as? URLError)?.code == .cancelled
        || (nsError.domain == NSURLErrorDomain && nsError.code == URLError.cancelled.rawValue)
      {
        throw CancellationError()
      }
      throw transportError(for: error, request: descriptor)
    }
    guard let httpResponse = response as? HTTPURLResponse else {
      throw GatewayError.transport("Gateway returned a non-HTTP response")
    }
    guard (200..<300).contains(httpResponse.statusCode) else {
      // Body BEFORE status, and only on a speech-scoped request: the codes
      // `/speech/*` emits ride statuses that mean something else to
      // `mapHTTPError` (401 → repair-required, 502-on-relay → gateway
      // offline). Anything the speech vocabulary does not name — and any body
      // that will not decode — falls through untouched, so `.gateway` requests
      // are byte-for-byte unaffected.
      if descriptor.errorScope == .speech, let error = speechError(from: data) {
        throw error
      }
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

  private func transportError(for error: Error, request: GatewayRequest) -> any Error {
    let nsError = error as NSError
    let urlErrorCode: URLError.Code? =
      if let urlError = error as? URLError {
        urlError.code
      } else if nsError.domain == NSURLErrorDomain {
        URLError.Code(rawValue: nsError.code)
      } else {
        nil
      }
    if error is CancellationError || urlErrorCode == .cancelled {
      return CancellationError()
    }
    let outcomeIsAmbiguous =
      urlErrorCode == .timedOut || urlErrorCode == .networkConnectionLost
    if outcomeIsAmbiguous, request.method.isMutation {
      return GatewayError.mutationOutcomeUnknown(
        resourceID: request.resourceID,
        requestID: request.requestID
      )
    }
    return GatewayError.transport(error.localizedDescription)
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
    guard seconds.isFinite, seconds >= 0 else {
      return nil
    }
    let milliseconds = (seconds * 1_000).rounded()
    guard milliseconds.isFinite, milliseconds < Double(Int64.max) else {
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
