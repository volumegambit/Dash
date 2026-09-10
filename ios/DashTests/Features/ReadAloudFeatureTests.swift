import Foundation
import Testing

@testable import Dash

/// Read aloud (Task A9), driven entirely through fakes: the simulator has no
/// usable audio route, so both the gateway call (`SpeechSynthesizing`) and the
/// player (`AudioPlaying`) are substituted here and the real
/// `AudioPlaybackService`/`SpeechAudioSession` are exercised on a device.
/// What IS covered is everything that decides what the user sees — which
/// message is speaking, what is sent to the gateway, which failures surface
/// what copy, and every path that must release the process-wide audio session.
@Suite("Read aloud feature", .serialized)
@MainActor
struct ReadAloudFeatureTests {
  @Test("toggling a message reads it aloud through the gateway")
  func toggleStartsReading() async {
    let harness = Harness()
    let feature = harness.feature

    await feature.toggle(messageID: "m1", text: "**Ship** it")

    await harness.waitForPlayback()
    await expectEventuallyAsync("the player to receive the audio") {
      await harness.player.played.count == 1
    }
    // The gateway gets the SPOKEN text, never the markdown source: "star star
    // Ship star star it" is not a sentence anybody asked to hear.
    #expect(await harness.synthesizer.texts == ["Ship it"])
    #expect(feature.isLoading == false)
    #expect(feature.error == nil)
    // Playback is what needs the session; a synthesis that never plays must
    // not duck the user's music.
    #expect(harness.session.playbackActivations == 1)
    #expect(harness.session.deactivations == 0)
  }

  @Test("toggling the message that is speaking stops it")
  func toggleAgainStops() async {
    let harness = Harness()
    let feature = harness.feature

    await feature.toggle(messageID: "m1", text: "hello")
    await harness.waitForPlayback()

    await feature.toggle(messageID: "m1", text: "hello")

    #expect(feature.speakingMessageID == nil)
    #expect(await harness.player.stopCount == 1)
    #expect(await harness.synthesizer.texts.count == 1, "stopping must not re-synthesize")
    // Rule: the session is released whenever playback ends, for any reason.
    #expect(harness.session.deactivations == 1)
  }

  @Test("reading a second message replaces the first")
  func secondMessageReplacesTheFirst() async {
    let harness = Harness()
    let feature = harness.feature

    await feature.toggle(messageID: "m1", text: "first")
    await harness.waitForPlayback()

    await feature.toggle(messageID: "m2", text: "second")

    await expectEventually("the second to be selected") { feature.speakingMessageID == "m2" }
    await harness.waitForPlayback()
    #expect(await harness.player.stopCount == 1)
    #expect(await harness.synthesizer.texts == ["first", "second"])
    // The first read's playback returns as its `stop()` resolves — it must not
    // clear the state the second read just wrote.
    await Task.yield()
    #expect(feature.speakingMessageID == "m2")
  }

  @Test("playback ending on its own clears the state and releases the session")
  func naturalFinishClearsTheState() async {
    let harness = Harness()
    let feature = harness.feature

    await feature.toggle(messageID: "m1", text: "hello")
    await harness.waitForPlayback()

    await harness.player.finish()

    await expectEventually("the state to clear") { feature.speakingMessageID == nil }
    #expect(harness.session.deactivations == 1)
    #expect(feature.error == nil)
  }

  @Test("a synthesis failure surfaces the gateway's own sentence and clears on the next toggle")
  func errorSurfacesAndClears() async {
    let harness = Harness(
      result: .failure(
        GatewayError.speech(code: "provider_error", message: "ElevenLabs is down", retryable: true)
      )
    )
    let feature = harness.feature

    await feature.toggle(messageID: "m1", text: "hello")

    await expectEventually("the failure to surface") { feature.error != nil }
    #expect(feature.error == "ElevenLabs is down")
    #expect(feature.speakingMessageID == nil)
    #expect(feature.isLoading == false)
    #expect(harness.errors.messages == ["ElevenLabs is down"])
    // Nothing was activated, so nothing may be deactivated: a stray
    // `setActive(false)` would interrupt whatever else is playing.
    #expect(harness.session.playbackActivations == 0)
    #expect(harness.session.deactivations == 0)

    await harness.synthesizer.setResult(.success(Data([0x01])))
    await feature.toggle(messageID: "m2", text: "hello again")

    #expect(feature.error == nil, "a fresh attempt clears the last one's banner")
    #expect(harness.errors.messages == ["ElevenLabs is down", nil])
  }

  @Test("a gateway without speech configured gets its own copy, not the raw code")
  func unavailableCopy() async {
    let harness = Harness(
      result: .failure(
        GatewayError.speech(code: "unavailable", message: "speech is not configured", retryable: false)
      )
    )

    await harness.feature.toggle(messageID: "m1", text: "hello")

    await expectEventually("the failure to surface") { harness.feature.error != nil }
    #expect(harness.feature.error == "Speech isn't set up on your gateway yet.")
  }

  @Test("a rejected provider key reads as a key problem, never as a pairing problem")
  func unauthorizedCopy() async {
    let harness = Harness(
      result: .failure(
        GatewayError.speech(code: "unauthorized", message: "401", retryable: false)
      )
    )

    await harness.feature.toggle(messageID: "m1", text: "hello")

    await expectEventually("the failure to surface") { harness.feature.error != nil }
    #expect(harness.feature.error == "Your gateway's speech provider key was rejected.")
  }

  @Test("a non-speech failure gets the plain read-aloud sentence")
  func genericCopy() async {
    let harness = Harness(result: .failure(GatewayError.unauthorized))

    await harness.feature.toggle(messageID: "m1", text: "hello")

    await expectEventually("the failure to surface") { harness.feature.error != nil }
    #expect(harness.feature.error == "Couldn't read this message aloud. Try again.")
  }

  @Test("audio that will not decode surfaces the plain sentence and releases the session")
  func playbackFailureSurfaces() async {
    let harness = Harness()
    await harness.player.setFailure(AudioPlaybackError.couldNotDecode)

    await harness.feature.toggle(messageID: "m1", text: "hello")

    await expectEventually("the failure to surface") { harness.feature.error != nil }
    #expect(harness.feature.error == "Couldn't read this message aloud. Try again.")
    #expect(harness.feature.speakingMessageID == nil)
    #expect(harness.session.deactivations == 1)
  }

  @Test("exactly 4 000 characters is sent whole")
  func fourThousandCharactersIsNotTruncated() async {
    let harness = Harness()
    let text = String(repeating: "a", count: 4_000)

    await harness.feature.toggle(messageID: "m1", text: text)

    await expectEventuallyAsync("the gateway call") { await harness.synthesizer.texts.count == 1 }
    #expect(await harness.synthesizer.texts.first == text)
  }

  @Test("one character over the limit is truncated to 4 000 with an ellipsis")
  func aboveTheLimitIsTruncated() async {
    let harness = Harness()
    let text = String(repeating: "a", count: 4_001)

    await harness.feature.toggle(messageID: "m1", text: text)

    await expectEventuallyAsync("the gateway call") { await harness.synthesizer.texts.count == 1 }
    let sent = await harness.synthesizer.texts.first ?? ""
    // The gateway counts UTF-16 units (`text.length` in `speech-routes.ts`),
    // and 413s above 4 000 — the ellipsis has to fit INSIDE the budget.
    #expect(sent.utf16.count == 4_000)
    #expect(sent.hasSuffix("…"))
  }

  @Test("an emoji reply is truncated by the unit the gateway counts, not by grapheme")
  func truncationCountsUTF16() async {
    let harness = Harness()
    // 2 000 emoji = 4 000 UTF-16 units but only 2 000 Characters: counting
    // graphemes would send a body the route rejects.
    let text = String(repeating: "😀", count: 2_001)

    await harness.feature.toggle(messageID: "m1", text: text)

    await expectEventuallyAsync("the gateway call") { await harness.synthesizer.texts.count == 1 }
    let sent = await harness.synthesizer.texts.first ?? ""
    #expect(sent.utf16.count <= 4_000)
    #expect(sent.hasSuffix("…"))
  }

  @Test("a message with nothing to read never calls the gateway")
  func emptyTextIsIgnored() async {
    let harness = Harness()

    await harness.feature.toggle(messageID: "m1", text: "   \n---\n")

    #expect(await harness.synthesizer.texts.isEmpty)
    #expect(harness.feature.speakingMessageID == nil)
  }

  @Test("a phone call stops playback and does not resume it")
  func interruptionStopsPlayback() async {
    let harness = Harness()
    let feature = harness.feature

    await feature.toggle(messageID: "m1", text: "hello")
    await harness.waitForPlayback()

    harness.interruptions.begin()

    await expectEventually("playback to stop") { feature.speakingMessageID == nil }
    #expect(await harness.player.stopCount == 1)
    #expect(harness.session.deactivations == 1)
    // `.ended` deliberately never arrives here: read aloud does not auto-resume.
    #expect(await harness.player.played.count == 1)
  }

  @Test("shutting the feature down stops playback and releases what its factory built")
  func shutdownStopsAndRetires() async {
    let harness = Harness()
    let feature = harness.feature

    await feature.toggle(messageID: "m1", text: "hello")
    await harness.waitForPlayback()

    await feature.shutdown()

    #expect(feature.speakingMessageID == nil)
    #expect(await harness.player.stopCount == 1)
    #expect(harness.session.deactivations == 1)
    #expect(await harness.retirements.count == 1)
  }

  @MainActor
  private struct Harness {
    let feature: ReadAloudFeature
    let synthesizer: FakeSpeechSynthesizer
    let player: FakeAudioPlayer
    let session: FakeSpeechSessionControl
    let interruptions = FakeInterruptionSource()
    let errors = ErrorRecorder()
    let retirements = RetirementRecorder()

    init(result: Result<Data, Error> = .success(Data([0x49, 0x44, 0x33]))) {
      synthesizer = FakeSpeechSynthesizer(result: result)
      player = FakeAudioPlayer()
      session = FakeSpeechSessionControl()
      let source = interruptions
      let retiring = retirements
      feature = ReadAloudFeature(
        synthesizer: synthesizer,
        player: player,
        session: session,
        interruptions: { source.stream() },
        onRetire: { await retiring.record() }
      )
      let recorder = errors
      feature.onErrorChanged = { message in
        recorder.append(message)
      }
    }

    /// Waits until audio is actually PLAYING, not merely selected:
    /// `speakingMessageID` is set the instant `toggle` is called, before the
    /// gateway has been asked for a single byte, so waiting on it would let a
    /// test stop/interrupt a read that has not activated the audio session
    /// yet.
    func waitForPlayback() async {
      await expectEventuallyAsync("playback to be underway") {
        await player.isPlaying
      }
    }
  }
}

@MainActor
final class ErrorRecorder {
  private(set) var messages: [String?] = []

  func append(_ message: String?) {
    messages.append(message)
  }
}

/// Counts `onRetire` calls. An actor because `onRetire` is a nonisolated
/// `@Sendable` closure, like `DictationFeature`'s.
actor RetirementRecorder {
  private(set) var count = 0

  func record() {
    count += 1
  }
}

/// Polls an ASYNC main-actor condition — the `expectEventually` in
/// `DictationFeatureTests` takes a synchronous closure, and every fake here is
/// an actor.
@MainActor
func expectEventuallyAsync(
  _ description: String,
  timeout: Duration = .seconds(2),
  _ condition: @MainActor () async -> Bool,
  sourceLocation: SourceLocation = #_sourceLocation
) async {
  let deadline = ContinuousClock().now.advanced(by: timeout)
  while ContinuousClock().now < deadline {
    if await condition() { return }
    await Task.yield()
    try? await Task.sleep(for: .milliseconds(2))
  }
  Issue.record("Timed out waiting for \(description)", sourceLocation: sourceLocation)
}

actor FakeSpeechSynthesizer: SpeechSynthesizing {
  private var result: Result<Data, Error>
  private(set) var texts: [String] = []

  init(result: Result<Data, Error>) {
    self.result = result
  }

  func setResult(_ value: Result<Data, Error>) {
    result = value
  }

  func synthesize(text: String) async throws -> Data {
    texts.append(text)
    try Task.checkCancellation()
    return try result.get()
  }
}

/// Stands in for `AudioPlaybackService`. `playMP3` hangs — as real playback
/// does — until the test finishes it or something stops it, which is what
/// makes "is this message still speaking?" observable.
actor FakeAudioPlayer: AudioPlaying {
  private(set) var played: [Data] = []
  private(set) var stopCount = 0
  private var continuation: CheckedContinuation<Void, Error>?
  private var failure: Error?
  private var playing = false

  var isPlaying: Bool { playing }

  func setFailure(_ error: Error?) {
    failure = error
  }

  func playMP3(_ data: Data) async throws {
    played.append(data)
    if let failure { throw failure }
    playing = true
    try await withCheckedThrowingContinuation { continuation in
      self.continuation = continuation
    }
  }

  func stop() async {
    stopCount += 1
    finish()
  }

  /// Playback reaching its natural end.
  func finish() {
    guard let pending = continuation else { return }
    continuation = nil
    playing = false
    pending.resume()
  }
}
