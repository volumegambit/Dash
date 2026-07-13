struct PairingPayload: Decodable, Sendable {
  let v: Int
  let host: String
  let mgmtToken: String
  let chatToken: String
  let mgmtPort: Int?
  let chatPort: Int?
  let label: String?
  let secure: Bool?
  let relayCredential: String?
}
