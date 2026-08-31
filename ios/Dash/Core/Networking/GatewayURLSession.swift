import CryptoKit
import Foundation
import Security

enum GatewayCertificatePin {
  static func normalize(_ value: String?) -> String? {
    guard let value else { return nil }
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard normalized.count == 64,
      normalized.utf8.allSatisfy({ byte in
        (48...57).contains(byte) || (97...102).contains(byte)
      })
    else {
      return nil
    }
    return normalized
  }

  static func matches(certificateDER: Data, fingerprint: String) -> Bool {
    guard let normalized = normalize(fingerprint) else { return false }
    let digest = SHA256.hash(data: certificateDER)
    let actual = digest.map { String(format: "%02x", $0) }.joined()
    return actual == normalized
  }
}

private final class GatewayPinnedTrustDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
  private let fingerprint: String

  init(fingerprint: String) {
    self.fingerprint = fingerprint
  }

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler:
      @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust
    else {
      completionHandler(.performDefaultHandling, nil)
      return
    }
    guard let trust = challenge.protectionSpace.serverTrust,
      let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
      let leaf = chain.first
    else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    let leafData = SecCertificateCopyData(leaf) as Data
    guard GatewayCertificatePin.matches(certificateDER: leafData, fingerprint: fingerprint) else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }
}

enum GatewayURLSessionFactory {
  static func make(
    profile: ConnectionProfile,
    configuration: URLSessionConfiguration = .default
  ) -> URLSession {
    guard profile.mode == .lan,
      let fingerprint = GatewayCertificatePin.normalize(profile.tlsCertificateSha256)
    else {
      return URLSession(configuration: configuration)
    }
    return URLSession(
      configuration: configuration,
      delegate: GatewayPinnedTrustDelegate(fingerprint: fingerprint),
      delegateQueue: nil
    )
  }
}
