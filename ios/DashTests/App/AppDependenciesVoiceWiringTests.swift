import Foundation
import Testing

@testable import Dash

/// Voice mode shipped switched off: `ChatFeature` took its voice-session
/// factory as a dependency that defaulted to returning nil, and the app's own
/// wiring never passed one. The waveform button still appeared — that gate is
/// the gateway's `speech-v1` capability, not the factory — so the tap did
/// nothing at all. Every voice test injected its own factory, so none of them
/// could see it.
///
/// Two things now stand in the way of a repeat. `ChatFeature.init` takes the
/// factory with NO default, so a wiring that forgets it does not compile. And
/// the factory the app actually uses is named and built here, against the real
/// microphone and speaker, rather than living only inside
/// `AppDependencies.live()` — which CI cannot call, since it needs
/// machine-local configuration a runner does not have.
@MainActor
@Suite("Live dependency wiring — speech")
struct AppDependenciesVoiceWiringTests {
  @Test("the app's own voice factory builds a session")
  func liveFactoryBuildsASession() throws {
    let factory = AppDependencies.liveVoiceMode(clock: SystemAppClock())
    let session = try #require(
      factory("voice-session-1", "agent-1", "conversation-1", SilentVoiceTransport()),
      "the app's wiring cannot build a voice session"
    )
    // `id` is the only identifier the session exposes; the rest is private.
    // What matters here is simply that a real session came back at all.
    #expect(session.id == "voice-session-1")
  }
}

/// The smallest thing that satisfies the transport a voice session holds. It is
/// never driven: this suite asks whether the session can be BUILT from the
/// app's own wiring, which is the part that was missing.
private actor SilentVoiceTransport: ChatFeatureTransporting {
  func events() async -> AsyncThrowingStream<ChatConnectionEvent, Error> {
    AsyncThrowingStream { $0.finish() }
  }

  func resetAfterTerminalFailure() async {}
  func connect() async throws {}
  func sendTurn(
    id: String,
    agentID: String,
    conversationID: String,
    text: String,
    images: [MessageImage]
  ) async throws {}
  func resume(turnID: String, agentID: String, conversationID: String, sinceSeq: Int) async throws {}
  func answer(turnID: String, questionID: String, answer: String) async throws {}
  func cancel(turnID: String) async throws {}
  func subscribe(agentID: String, conversationID: String) async throws {}
  func unsubscribe(agentID: String, conversationID: String) async throws {}
  func voiceStart(id: String, agentID: String, conversationID: String) async throws {}
  func voiceAudio(id: String, seq: Int, pcm: Data) async throws {}
  func voiceMute(id: String, muted: Bool) async throws {}
  func voiceStop(id: String) async throws {}
  func voicePlayed(id: String, seq: Int) async throws {}
  func suspendForDetachment() async {}
  func shutdown() async {}
}
