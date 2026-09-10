import Foundation
@testable import Dash

private final class FixtureBundleToken {}

enum FixtureError: Error {
  case missing(String)
}

enum FixtureLoader {
  static func data(_ name: String) throws -> Data {
    guard let root = Bundle(for: FixtureBundleToken.self).resourceURL?
      .appendingPathComponent("fixtures", isDirectory: true)
    else {
      throw FixtureError.missing("fixtures/<root>")
    }
    let url = root.appendingPathComponent(name, isDirectory: false)
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw FixtureError.missing(url.path)
    }
    return try Data(contentsOf: url)
  }

  static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
    try ContractCoding.decoder().decode(type, from: data(name))
  }
}

enum MobileV2FixtureLoader {
  static func data(_ name: String) throws -> Data {
    guard let root = Bundle(for: FixtureBundleToken.self).resourceURL?
      .appendingPathComponent("MobileV2ContractFixtures", isDirectory: true)
      .appendingPathComponent("fixtures", isDirectory: true)
    else {
      throw FixtureError.missing("MobileV2ContractFixtures/<root>")
    }
    let url = root.appendingPathComponent(name, isDirectory: false)
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw FixtureError.missing(url.path)
    }
    return try Data(contentsOf: url)
  }

  static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
    try ContractCoding.decoder().decode(type, from: data(name))
  }

  static func jsonLines(_ name: String) throws -> [Data] {
    try String(decoding: data(name), as: UTF8.self)
      .split(whereSeparator: \.isNewline)
      .map { Data($0.utf8) }
  }
}
