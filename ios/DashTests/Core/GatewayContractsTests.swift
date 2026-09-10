import Foundation
import Testing

@testable import Dash

@Suite("Gateway contracts")
struct GatewayContractsTests {
  /// The deployment-order rule for `/health`: a gateway may advertise a
  /// capability this build has never heard of (that is exactly what happens
  /// between shipping a gateway and shipping the app update that uses it).
  /// Before this, `[MobileCapability]` decoded strictly, so ONE unknown string
  /// threw a `DecodingError` — which `HTTPTransport.send` maps to
  /// `GatewayError.updateRequired`, i.e. the whole connection refuses to verify
  /// rather than one unusable feature staying hidden.
  @Test("an unknown capability is dropped instead of failing the health decode")
  func unknownCapabilityIsDropped() throws {
    let json = """
      {
        "status": "healthy",
        "startedAt": "2026-07-12T00:00:00.000Z",
        "pid": 4242,
        "agents": 1,
        "channels": 1,
        "apiVersion": 1,
        "capabilities": ["conversation-sync-v1", "chat-resume-v1", "future-v9"]
      }
      """

    let health = try ContractCoding.decoder().decode(HealthResponse.self, from: Data(json.utf8))

    #expect(health.capabilities == [.conversationSyncV1, .chatResumeV1])
    #expect(health.status == "healthy")
    #expect(health.apiVersion == 1)
  }

  @Test("speech-v1 decodes as a known capability")
  func speechCapabilityDecodes() throws {
    let json = """
      {
        "status": "healthy",
        "startedAt": "2026-07-12T00:00:00.000Z",
        "pid": 1,
        "agents": 0,
        "channels": 0,
        "apiVersion": 1,
        "capabilities": ["speech-v1"]
      }
      """

    let health = try ContractCoding.decoder().decode(HealthResponse.self, from: Data(json.utf8))

    #expect(health.capabilities == [.speechV1])
    #expect(MobileCapability.speechV1.rawValue == "speech-v1")
  }

  /// Dropping unknowns must not also swallow a MALFORMED array — a
  /// `capabilities` that is not an array of strings is a broken gateway, not a
  /// newer one, and the client should still refuse it.
  @Test("a non-string capability array still fails the decode")
  func malformedCapabilitiesStillThrow() {
    let json = """
      {
        "status": "healthy",
        "startedAt": "2026-07-12T00:00:00.000Z",
        "pid": 1,
        "agents": 0,
        "channels": 0,
        "apiVersion": 1,
        "capabilities": [17]
      }
      """

    #expect(throws: DecodingError.self) {
      try ContractCoding.decoder().decode(HealthResponse.self, from: Data(json.utf8))
    }
  }

  /// `SpeechConfigPatch.realtime` is the one place omission and `null` differ:
  /// the gateway's `validateRealtimePatch` REQUIRES the `provider` key inside a
  /// present `realtime` object and accepts `null` as the value. Swift's
  /// synthesized `Codable` would `encodeIfPresent` a `String?` and drop the key
  /// entirely, so "turn realtime off" would arrive as `{"realtime":{}}` and be
  /// rejected with a 400.
  @Test("a null realtime provider is encoded as an explicit JSON null")
  func realtimePatchEncodesExplicitNull() throws {
    let patch = SpeechConfigPatchDTO(realtime: SpeechRealtimeConfigDTO(provider: nil))

    let encoded = try ContractCoding.encoder().encode(patch)
    let object = try #require(
      JSONSerialization.jsonObject(with: encoded) as? [String: Any]
    )
    let realtime = try #require(object["realtime"] as? [String: Any])

    #expect(realtime.keys.sorted() == ["provider"])
    #expect(realtime["provider"] is NSNull)
    // The omitted sections stay omitted — a patch never resends what it is not
    // changing.
    #expect(object.keys.sorted() == ["realtime"])
  }

  @Test("a partial speech patch sends only the keys it changes")
  func partialPatchOmitsUntouchedKeys() throws {
    let patch = SpeechConfigPatchDTO(tts: SpeechTtsPatchDTO(voice: "nova"))

    let encoded = try ContractCoding.encoder().encode(patch)
    let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])

    #expect(object.keys.sorted() == ["tts"])
    let tts = try #require(object["tts"] as? [String: Any])
    #expect(tts.keys.sorted() == ["voice"])
    #expect(tts["voice"] as? String == "nova")
  }
}
