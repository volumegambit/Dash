import Foundation

enum LegacyRunID {
  static let maxUTF8Bytes = 256

  static func isValid(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard (1...maxUTF8Bytes).contains(bytes.count) else { return false }
    return bytes.contains { byte in
      byte != 0x20 && byte != 0x09 && byte != 0x0D && byte != 0x0A
    }
  }
}

enum MobileV2ContractValidationError: Error, Equatable, Sendable {
  case missingKeys([String])
  case unexpectedKeys([String])
  case invalidField(String)
}

struct MobileV2AnyCodingKey: CodingKey, Hashable {
  let stringValue: String
  let intValue: Int?

  init?(stringValue: String) {
    self.stringValue = stringValue
    intValue = nil
  }

  init?(intValue: Int) {
    stringValue = String(intValue)
    self.intValue = intValue
  }
}

enum MobileV2ContractValidation {
  static let maxSafeInteger = 9_007_199_254_740_991
  static let apiErrorCodes: Set<String> = [
    "unauthorized",
    "not_found",
    "validation_failed",
    "revision_conflict",
    "conversation_busy",
    "rate_limited",
    "gateway_offline",
    "capability_required",
  ]

  static func validateKeys(
    _ decoder: Decoder,
    allowed: Set<String>,
    required: Set<String>
  ) throws {
    let container = try decoder.container(keyedBy: MobileV2AnyCodingKey.self)
    let actual = Set(container.allKeys.map(\.stringValue))
    let missing = required.subtracting(actual).sorted()
    if missing.isEmpty == false {
      throw MobileV2ContractValidationError.missingKeys(missing)
    }
    let unexpected = actual.subtracting(allowed).sorted()
    if unexpected.isEmpty == false {
      throw MobileV2ContractValidationError.unexpectedKeys(unexpected)
    }
  }

  static func require(_ condition: @autoclosure () -> Bool, field: String) throws {
    guard condition() else { throw MobileV2ContractValidationError.invalidField(field) }
  }

  static func validateCanonicalUUID(_ value: String, field: String) throws {
    let bytes = Array(value.utf8)
    let hyphenOffsets: Set<Int> = [8, 13, 18, 23]
    let isHex: (UInt8) -> Bool = { byte in
      (0x30...0x39).contains(byte) || (0x41...0x46).contains(byte)
        || (0x61...0x66).contains(byte)
    }
    try require(bytes.count == 36, field: field)
    for (offset, byte) in bytes.enumerated() {
      if hyphenOffsets.contains(offset) {
        try require(byte == 0x2D, field: field)
      } else {
        try require(isHex(byte), field: field)
      }
    }
  }

  static func validateLegacyRunID(_ value: String, field: String) throws {
    try require(LegacyRunID.isValid(value), field: field)
  }

  static func validateNonempty(_ value: String, field: String) throws {
    try require(value.isEmpty == false, field: field)
  }

  static func validateNonnegative(_ value: Int, field: String) throws {
    try require(value >= 0 && value <= maxSafeInteger, field: field)
  }

  static func validatePositive(_ value: Int, field: String) throws {
    try require(value >= 1 && value <= maxSafeInteger, field: field)
  }

  static func validateCapabilities(_ capabilities: [String]) throws {
    try require(capabilities.allSatisfy { $0.isEmpty == false }, field: "capabilities")
    try require(Set(capabilities).count == capabilities.count, field: "capabilities")
  }

  static func validateOptionalNonNull<Key: CodingKey>(
    _ container: KeyedDecodingContainer<Key>,
    key: Key
  ) throws {
    if container.contains(key), try container.decodeNil(forKey: key) {
      throw MobileV2ContractValidationError.invalidField(key.stringValue)
    }
  }
}

struct MobileV2HealthResponse: Codable, Hashable, Sendable {
  let status: String
  let startedAt: Date
  let pid: Int
  let agents: Int
  let channels: Int
  let apiVersion: Int
  let capabilities: [String]

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case status
    case startedAt
    case pid
    case agents
    case channels
    case apiVersion
    case capabilities
  }

  init(
    status: String,
    startedAt: Date,
    pid: Int,
    agents: Int,
    channels: Int,
    apiVersion: Int,
    capabilities: [String]
  ) {
    self.status = status
    self.startedAt = startedAt
    self.pid = pid
    self.agents = agents
    self.channels = channels
    self.apiVersion = apiVersion
    self.capabilities = capabilities
  }

  init(from decoder: Decoder) throws {
    let keys = Set(CodingKeys.allCases.map(\.rawValue))
    try MobileV2ContractValidation.validateKeys(decoder, allowed: keys, required: keys)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    status = try container.decode(String.self, forKey: .status)
    startedAt = try container.decode(Date.self, forKey: .startedAt)
    pid = try container.decode(Int.self, forKey: .pid)
    agents = try container.decode(Int.self, forKey: .agents)
    channels = try container.decode(Int.self, forKey: .channels)
    apiVersion = try container.decode(Int.self, forKey: .apiVersion)
    capabilities = try container.decode([String].self, forKey: .capabilities)
    try validate()
  }

  func encode(to encoder: Encoder) throws {
    try validate()
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(status, forKey: .status)
    try container.encode(startedAt, forKey: .startedAt)
    try container.encode(pid, forKey: .pid)
    try container.encode(agents, forKey: .agents)
    try container.encode(channels, forKey: .channels)
    try container.encode(apiVersion, forKey: .apiVersion)
    try container.encode(capabilities, forKey: .capabilities)
  }

  private func validate() throws {
    try MobileV2ContractValidation.require(status == "healthy", field: "status")
    try MobileV2ContractValidation.validatePositive(pid, field: "pid")
    try MobileV2ContractValidation.validateNonnegative(agents, field: "agents")
    try MobileV2ContractValidation.validateNonnegative(channels, field: "channels")
    try MobileV2ContractValidation.require(apiVersion == 2, field: "apiVersion")
    try MobileV2ContractValidation.validateCapabilities(capabilities)
  }
}
