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
  let tlsCertificateSha256: String?

  init(
    v: Int,
    host: String,
    mgmtToken: String,
    chatToken: String,
    mgmtPort: Int?,
    chatPort: Int?,
    label: String?,
    secure: Bool?,
    relayCredential: String?,
    tlsCertificateSha256: String? = nil
  ) {
    self.v = v
    self.host = host
    self.mgmtToken = mgmtToken
    self.chatToken = chatToken
    self.mgmtPort = mgmtPort
    self.chatPort = chatPort
    self.label = label
    self.secure = secure
    self.relayCredential = relayCredential
    self.tlsCertificateSha256 = tlsCertificateSha256
  }
}
