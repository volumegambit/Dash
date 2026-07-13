import Foundation
import Security
import Testing
@testable import Dash

private final class KeychainRecorder: @unchecked Sendable {
  var addQuery: NSDictionary?
  var updateQuery: NSDictionary?
  var updateAttributes: NSDictionary?
  var copyQuery: NSDictionary?
  var deleteQuery: NSDictionary?
  var addCalls = 0
  var updateCalls = 0
}

@Suite("device-only Keychain secrets")
struct KeychainStoreTests {
  @Test("save uses device-only generic-password attributes and one encoded value")
  func saveAttributes() async throws {
    let recorder = KeychainRecorder()
    let client = SecItemClient(
      add: { query, _ in
        recorder.addCalls += 1
        recorder.addQuery = query as NSDictionary
        return errSecSuccess
      },
      update: { _, _ in errSecSuccess },
      copyMatching: { _, _ in errSecItemNotFound },
      delete: { _ in errSecSuccess }
    )
    let profileID = UUID()
    let secrets = sampleSecrets()
    let store = SystemKeychainStore(client: client)

    try await store.save(secrets, for: profileID)

    let query = try #require(recorder.addQuery)
    #expect(query[kSecClass] as? String == kSecClassGenericPassword as String)
    #expect(query[kSecAttrService] as? String == SystemKeychainStore.service)
    #expect(query[kSecAttrAccount] as? String == profileID.uuidString.lowercased())
    #expect(
      query[kSecAttrAccessible] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String
    )
    #expect(query[kSecAttrSynchronizable] as? Bool == false)
    let data = try #require(query[kSecValueData] as? Data)
    #expect(try JSONDecoder().decode(ConnectionSecrets.self, from: data) == secrets)
    let rendered = String(describing: query)
    #expect(rendered.contains("gateway.example") == false)
    #expect(rendered.contains("Home Gateway") == false)
  }

  @Test("duplicate save updates the existing account")
  func duplicateUpdates() async throws {
    let recorder = KeychainRecorder()
    let client = SecItemClient(
      add: { _, _ in
        recorder.addCalls += 1
        return errSecDuplicateItem
      },
      update: { query, attributes in
        recorder.updateCalls += 1
        recorder.updateQuery = query as NSDictionary
        recorder.updateAttributes = attributes as NSDictionary
        return errSecSuccess
      },
      copyMatching: { _, _ in errSecItemNotFound },
      delete: { _ in errSecSuccess }
    )
    let profileID = UUID()
    let store = SystemKeychainStore(client: client)

    try await store.save(sampleSecrets(), for: profileID)

    #expect(recorder.addCalls == 1)
    #expect(recorder.updateCalls == 1)
    let query = try #require(recorder.updateQuery)
    #expect(query[kSecClass] as? String == kSecClassGenericPassword as String)
    #expect(query[kSecAttrService] as? String == SystemKeychainStore.service)
    #expect(query[kSecAttrAccount] as? String == profileID.uuidString.lowercased())
    #expect(recorder.updateAttributes?[kSecValueData] is Data)
  }

  @Test("load requests one data value and decodes the aggregate secret")
  func loadValue() async throws {
    let recorder = KeychainRecorder()
    let expected = sampleSecrets()
    let data = try JSONEncoder().encode(expected)
    let client = SecItemClient(
      add: { _, _ in errSecSuccess },
      update: { _, _ in errSecSuccess },
      copyMatching: { query, result in
        recorder.copyQuery = query as NSDictionary
        result?.pointee = data as CFData
        return errSecSuccess
      },
      delete: { _ in errSecSuccess }
    )
    let store = SystemKeychainStore(client: client)

    #expect(try await store.load(for: UUID()) == expected)
    let query = try #require(recorder.copyQuery)
    #expect(query[kSecReturnData] as? Bool == true)
    #expect(query[kSecMatchLimit] as? String == kSecMatchLimitOne as String)
  }

  @Test("missing load returns nil")
  func missingLoad() async throws {
    let store = SystemKeychainStore(
      client: SecItemClient(
        add: { _, _ in errSecSuccess },
        update: { _, _ in errSecSuccess },
        copyMatching: { _, _ in errSecItemNotFound },
        delete: { _ in errSecSuccess }
      )
    )
    #expect(try await store.load(for: UUID()) == nil)
  }

  @Test("delete is idempotent and uses only the stable account")
  func idempotentDelete() async throws {
    let recorder = KeychainRecorder()
    let profileID = UUID()
    let store = SystemKeychainStore(
      client: SecItemClient(
        add: { _, _ in errSecSuccess },
        update: { _, _ in errSecSuccess },
        copyMatching: { _, _ in errSecItemNotFound },
        delete: { query in
          recorder.deleteQuery = query as NSDictionary
          return errSecItemNotFound
        }
      )
    )

    try await store.delete(for: profileID)

    let query = try #require(recorder.deleteQuery)
    #expect(query[kSecAttrAccount] as? String == profileID.uuidString.lowercased())
    #expect(query[kSecAttrService] as? String == SystemKeychainStore.service)
  }

  @Test("unexpected status maps to a redacted Keychain error")
  func statusError() async {
    let store = SystemKeychainStore(
      client: SecItemClient(
        add: { _, _ in errSecAuthFailed },
        update: { _, _ in errSecSuccess },
        copyMatching: { _, _ in errSecItemNotFound },
        delete: { _ in errSecSuccess }
      )
    )

    do {
      try await store.save(sampleSecrets(), for: UUID())
      Issue.record("expected KeychainError")
    } catch let error as KeychainError {
      #expect(error.operation == "save")
      #expect(error.status == errSecAuthFailed)
      #expect(String(describing: error).contains("management-secret") == false)
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  private func sampleSecrets() -> ConnectionSecrets {
    ConnectionSecrets(
      managementToken: "management-secret",
      chatToken: "chat-secret",
      relayCredential: "relay-secret"
    )
  }
}
