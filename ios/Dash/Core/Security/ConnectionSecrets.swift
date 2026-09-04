struct ConnectionSecrets: Codable, Equatable, Sendable {
  let managementToken: String
  let chatToken: String
  let relayCredential: String?
}
