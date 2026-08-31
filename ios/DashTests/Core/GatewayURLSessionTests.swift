import CryptoKit
import Foundation
import Testing

@testable import Dash

@Suite("gateway certificate pinning")
struct GatewayURLSessionTests {
  @Test("matches only the exact DER leaf SHA-256 fingerprint")
  func exactLeafMatch() {
    let leaf = Data("dash-test-leaf".utf8)
    let fingerprint = SHA256.hash(data: leaf).map { String(format: "%02x", $0) }.joined()

    #expect(GatewayCertificatePin.matches(certificateDER: leaf, fingerprint: fingerprint))
    #expect(
      GatewayCertificatePin.matches(
        certificateDER: Data("different-leaf".utf8),
        fingerprint: fingerprint
      ) == false
    )
    #expect(GatewayCertificatePin.matches(certificateDER: leaf, fingerprint: "abc") == false)
  }
}
