import Foundation

/// A gateway as listed by the control plane for the signed-in account.
struct GatewayInfoDTO: Decodable, Equatable, Sendable {
  let gatewayId: String
  /// The FULL relay host (e.g. `mygw.relay.dash.example`) — never re-append a
  /// zone to this value.
  let subdomain: String
  let status: String
  /// The gateway's Ed25519 public key (raw, base64url) as recorded when the
  /// account enrolled it. This is the ACCOUNT's record of who the gateway is;
  /// `AccountConnectFeature.connect` refuses to install a pairing whose
  /// relay-verified `/identity` disagrees with it, so a relay that
  /// impersonated a tenant's subdomain still cannot get a credential
  /// installed. Non-optional on purpose: a control plane that stopped sending
  /// it must fail loudly at decode rather than silently disarm that check.
  let publicKey: String
}

/// The credential minted for a mobile device pairing with a gateway.
struct PairingGrant: Decodable, Equatable, Sendable {
  let credential: String
  let pairingId: String
  /// Absent when the account isn't yet chat-enrolled on this gateway. The
  /// caller (Task 5) is responsible for mapping a `nil` chatToken to
  /// `.notEnrolled` — this client just decodes what the server sent.
  let chatToken: String?
  let status: String
}

/// A pending (or already-decided/expired) signer-gated approval, as returned
/// by `GET /v1/approvals/:id` (Task 3). `expiresAt` is an ISO-8601 string —
/// this client doesn't parse it; the caller (Task 6) decides how to render or
/// compare it.
struct ApprovalRequestDTO: Decodable, Equatable, Sendable {
  let approvalId: String
  let pairingId: String
  let gatewayId: String
  let deviceLabel: String
  let expiresAt: String
}

enum ControlPlaneError: Error, Equatable {
  case signInRequired
  case unauthorized
  case notEnrolled
  case network
  case decoding
  /// `403` on `POST /v1/approvals/:id/decision`: the signature did not verify
  /// or `signerId` isn't registered under this account (Task 3 deliberately
  /// makes those indistinguishable). Task 6 shows "forbidden" copy for this.
  case forbidden
  /// `410` on `POST /v1/approvals/:id/decision`: the approval's TTL elapsed
  /// or it already received a decision — "too late" either way. Task 6 shows
  /// "expired" copy for this.
  case expired
}

/// Talks to the Dash control plane on behalf of a signed-in account: listing
/// the account's gateways and minting/revoking mobile pairing credentials
/// against them. Deliberately does not reuse `HTTPTransport` — that type is
/// gateway-coupled (per-connection management token, relay credential
/// headers, gateway-shaped error contract) whereas this client talks to a
/// different service with a Clerk bearer token and its own response shapes.
actor ControlPlaneClient {
  private let config: AccountAuthConfig
  private let tokens: AccountSession
  private let session: URLSession

  init(config: AccountAuthConfig, tokens: AccountSession, session: URLSession = .shared) {
    self.config = config
    self.tokens = tokens
    self.session = session
  }

  /// `GET /v1/gateways`, unwrapping the `{ gateways: [...] }` envelope.
  func listGateways() async throws -> [GatewayInfoDTO] {
    struct Envelope: Decodable {
      let gateways: [GatewayInfoDTO]
    }
    let envelope: Envelope = try await send(method: "GET", pathSegments: ["v1", "gateways"])
    return envelope.gateways
  }

  /// `POST /v1/gateways/:id/pairings/pairing-id-v1` with
  /// `{ deviceLabel, clientKind: "mobile" }`.
  func createPairing(gatewayId: String, deviceLabel: String) async throws -> PairingGrant {
    struct MintRequest: Encodable, Sendable {
      let deviceLabel: String
      let clientKind: String
    }
    return try await send(
      method: "POST",
      pathSegments: ["v1", "gateways", gatewayId, "pairings", "pairing-id-v1"],
      body: MintRequest(deviceLabel: deviceLabel, clientKind: "mobile")
    )
  }

  /// `DELETE /v1/gateways/:id/pairings/:pairingId`.
  func revokePairing(gatewayId: String, pairingId: String) async throws {
    _ = try await performRequest(
      method: "DELETE",
      pathSegments: ["v1", "gateways", gatewayId, "pairings", pairingId]
    )
  }

  /// `POST /v1/signers` with `{ publicKey, label }`, returning the resulting
  /// `signerId`. Idempotent server-side (Task 3): registering the same
  /// `publicKey` again returns the same `signerId` rather than erroring.
  func registerSigner(publicKey: String, label: String) async throws -> String {
    struct RegisterRequest: Encodable, Sendable {
      let publicKey: String
      let label: String
    }
    struct RegisterResponse: Decodable {
      let signerId: String
    }
    let response: RegisterResponse = try await send(
      method: "POST",
      pathSegments: ["v1", "signers"],
      body: RegisterRequest(publicKey: publicKey, label: label)
    )
    return response.signerId
  }

  /// `GET /v1/approvals/:id`.
  func fetchApproval(id: String) async throws -> ApprovalRequestDTO {
    try await send(method: "GET", pathSegments: ["v1", "approvals", id])
  }

  /// `POST /v1/approvals/:id/decision` with
  /// `{ decision, signerId, signature }`. `204` on success (approve or deny
  /// alike); see `performRequest`'s status mapping for the `403`/`410` typed
  /// errors this can throw.
  func postDecision(
    approvalId: String,
    decision: String,
    signerId: String,
    signature: String
  ) async throws {
    struct DecisionRequest: Encodable, Sendable {
      let decision: String
      let signerId: String
      let signature: String
    }
    _ = try await performRequest(
      method: "POST",
      pathSegments: ["v1", "approvals", approvalId, "decision"],
      body: DecisionRequest(decision: decision, signerId: signerId, signature: signature)
    )
  }

  private func send<Response: Decodable>(
    method: String,
    pathSegments: [String],
    body: (any Encodable & Sendable)? = nil
  ) async throws -> Response {
    let data = try await performRequest(method: method, pathSegments: pathSegments, body: body)
    do {
      return try JSONDecoder().decode(Response.self, from: data)
    } catch {
      throw ControlPlaneError.decoding
    }
  }

  private func performRequest(
    method: String,
    pathSegments: [String],
    body: (any Encodable & Sendable)? = nil
  ) async throws -> Data {
    let token: String
    do {
      token = try await tokens.idToken()
    } catch {
      throw ControlPlaneError.signInRequired
    }

    var request = URLRequest(url: try url(forPathSegments: pathSegments))
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.httpBody = try JSONEncoder().encode(body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw ControlPlaneError.network
    }
    guard let httpResponse = response as? HTTPURLResponse else {
      throw ControlPlaneError.network
    }
    guard (200..<300).contains(httpResponse.statusCode) else {
      switch httpResponse.statusCode {
      case 401:
        throw ControlPlaneError.unauthorized
      case 403:
        throw ControlPlaneError.forbidden
      case 410:
        throw ControlPlaneError.expired
      default:
        throw ControlPlaneError.network
      }
    }
    return data
  }

  private func url(forPathSegments segments: [String]) throws -> URL {
    guard
      var components = URLComponents(
        url: config.controlPlaneURL,
        resolvingAgainstBaseURL: false
      )
    else {
      throw ControlPlaneError.network
    }
    var allowed = CharacterSet.urlPathAllowed
    allowed.remove(charactersIn: "/?#%")
    let encodedSegments = try segments.map { segment -> String in
      guard let encoded = segment.addingPercentEncoding(withAllowedCharacters: allowed) else {
        throw ControlPlaneError.network
      }
      return encoded
    }
    let basePath = components.percentEncodedPath
    let trimmedBase = basePath.hasSuffix("/") ? String(basePath.dropLast()) : basePath
    components.percentEncodedPath = trimmedBase + "/" + encodedSegments.joined(separator: "/")
    guard let url = components.url else {
      throw ControlPlaneError.network
    }
    return url
  }
}
