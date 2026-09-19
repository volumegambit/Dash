import Foundation
import Testing

@testable import Dash

@Suite("coarse location provider")
struct LocationProviderTests {
  @Test("reads a well-formed coarse tier with no permission prompt")
  func coarseIsWellFormed() throws {
    let location = try #require(LocationProvider.coarse())
    #expect(!location.timezone.isEmpty)
    #expect(!location.locale.isEmpty)
    // Coarse never carries a position.
    #expect(location.precise == nil)
    // Never an empty region -- the gateway rejects the whole coarse tier on one.
    #expect(location.region != "")
  }

  @Test("reports minutes EAST of UTC, matching TimeZone.secondsFromGMT")
  func offsetIsEastPositive() throws {
    let location = try #require(LocationProvider.coarse())
    #expect(location.utcOffsetMinutes == TimeZone.current.secondsFromGMT() / 60)
    #expect(location.timezone == TimeZone.current.identifier)
  }

  @Test("a ClientLocation round-trips through the contract coder")
  func clientLocationRoundTrips() throws {
    let original = ClientLocation(
      timezone: "Asia/Singapore",
      utcOffsetMinutes: 480,
      locale: "en-SG",
      region: "SG",
      precise: PreciseLocation(
        latitude: 1.2966,
        longitude: 103.7764,
        accuracyMeters: 12,
        capturedAt: "2026-09-06T10:11:02Z",
        place: "National University of Singapore"
      )
    )
    let data = try ContractCoding.encoder().encode(original)
    let decoded = try ContractCoding.decoder().decode(ClientLocation.self, from: data)
    #expect(decoded == original)
  }

  @Test("precise location is off until the user opts in")
  func preciseIsOffByDefault() throws {
    let defaults = try #require(UserDefaults(suiteName: "dash.location.tests.\(UUID().uuidString)"))
    defer { defaults.removePersistentDomain(forName: defaults.description) }
    let provider = PreciseLocationProvider(defaults: defaults)
    #expect(provider.isEnabled == false)
    #expect(provider.cachedFix() == nil)
  }

  @Test("a newTurn frame carries the location it was given")
  func newTurnCarriesLocation() throws {
    let location = ClientLocation(
      timezone: "Asia/Singapore",
      utcOffsetMinutes: 480,
      locale: "en-SG",
      region: "SG",
      precise: nil
    )
    let frame = MobileWSClientFrame.newTurn(
      id: "turn-01",
      agentId: "agent-01",
      conversationId: "conv-01",
      text: "where am I?",
      images: nil,
      location: location
    )
    guard case let .message(_, _, _, _, _, sent, _, _, _, _) = frame else {
      Issue.record("expected a message frame")
      return
    }
    #expect(sent == location)
  }
}
