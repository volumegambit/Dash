import Foundation
import Security

protocol KeychainStoring: Sendable {
  func save(_ secrets: ConnectionSecrets, for profileID: UUID) async throws
  func load(for profileID: UUID) async throws -> ConnectionSecrets?
  func delete(for profileID: UUID) async throws
}

struct SecItemClient: Sendable {
  let add: @Sendable (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
  let update: @Sendable (CFDictionary, CFDictionary) -> OSStatus
  let copyMatching: @Sendable (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
  let delete: @Sendable (CFDictionary) -> OSStatus

  static let system = SecItemClient(
    add: SecItemAdd,
    update: SecItemUpdate,
    copyMatching: SecItemCopyMatching,
    delete: SecItemDelete
  )
}

struct KeychainError: Error, Equatable, Sendable, CustomStringConvertible {
  let operation: String
  let status: OSStatus

  var description: String {
    "Keychain \(operation) failed with status \(status)"
  }
}

actor SystemKeychainStore: KeychainStoring {
  static let service = "app.dash.ios.gateway-secrets"

  private let client: SecItemClient

  init(client: SecItemClient = .system) {
    self.client = client
  }

  func save(_ secrets: ConnectionSecrets, for profileID: UUID) async throws {
    let data = try JSONEncoder().encode(secrets)
    var query = baseQuery(for: profileID)
    query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    query[kSecValueData as String] = data

    let status = client.add(query as CFDictionary, nil)
    if status == errSecDuplicateItem {
      let attributes = [kSecValueData as String: data]
      let updateStatus = client.update(
        baseQuery(for: profileID) as CFDictionary,
        attributes as CFDictionary
      )
      guard updateStatus == errSecSuccess else {
        throw KeychainError(operation: "save", status: updateStatus)
      }
      return
    }
    guard status == errSecSuccess else {
      throw KeychainError(operation: "save", status: status)
    }
  }

  func load(for profileID: UUID) async throws -> ConnectionSecrets? {
    var query = baseQuery(for: profileID)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var result: CFTypeRef?
    let status = client.copyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      return nil
    }
    guard status == errSecSuccess else {
      throw KeychainError(operation: "load", status: status)
    }
    guard let data = result as? Data else {
      throw KeychainError(operation: "load", status: errSecDecode)
    }
    return try JSONDecoder().decode(ConnectionSecrets.self, from: data)
  }

  func delete(for profileID: UUID) async throws {
    let status = client.delete(baseQuery(for: profileID) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainError(operation: "delete", status: status)
    }
  }

  private func baseQuery(for profileID: UUID) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service,
      kSecAttrAccount as String: profileID.uuidString.lowercased(),
      kSecAttrSynchronizable as String: false,
    ]
  }
}
