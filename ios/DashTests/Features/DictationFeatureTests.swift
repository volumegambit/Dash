import Foundation
import Testing

@testable import Dash

/// The composer's dictation feature, driven entirely through fakes: the
/// simulator has no microphone, so every audio-facing piece
/// (`AudioRecorderService`, `SpeechAudioSession`) is substituted here and
/// exercised on a device instead. What IS covered is everything that decides
/// what the user sees — permission, the meter and countdown, the 60 s cap,
/// which failures discard the recording, and which text reaches the draft.
@Suite("Dictation feature", .serialized)
@MainActor
struct DictationFeatureTests {
  @Test("a finished recording transcribes and hands the text to the composer")
  func happyPathInsertsTheTranscript() async {
    let harness = Harness(transcript: "hello world")
    let feature = harness.feature

    await feature.start()

    #expect(feature.state.phase == .recording(elapsed: .zero, level: 0))
    #expect(await harness.recorder.startCount == 1)
    #expect(harness.session.activations == 1)

    let text = await feature.finish()

    #expect(text == "hello world")
    #expect(harness.inserted.texts == ["hello world"])
    #expect(feature.state.phase == .idle)
    #expect(await harness.recorder.stopCount == 1)
    #expect(await harness.recorder.cancelCount == 0)
    // The session is process-wide: leaving it active after a recording keeps
    // the mic route armed and ducks whatever was playing before.
    #expect(harness.session.deactivations == 1)
  }

  @Test("a level sample moves the meter and the countdown")
  func meterAndCountdownFollowTheRecording() async {
    let harness = Harness(transcript: "ignored")
    let feature = harness.feature
    await feature.start()

    await harness.clock.setNow(harness.start.addingTimeInterval(5))
    harness.recorder.emit(0.125)

    await expectEventually("the meter to take a sample") {
      if case .recording(_, let level) = feature.state.phase { return level > 0 }
      return false
    }
    guard case .recording(let elapsed, let level) = feature.state.phase else {
      Issue.record("expected to still be recording, got \(feature.state.phase)")
      return
    }
    #expect(elapsed == .seconds(5))
    #expect(level == 0.125)
    #expect(feature.countdown == "0:55")
    // Normal speech is ≈0.1 linear amplitude; an un-renormalised bar at 10 %
    // reads as a dead microphone. (0.125 rather than 0.1 so the expected
    // value is exact in binary floating point.)
    #expect(feature.meterFraction == 0.5)
  }

  @Test("denied microphone permission fails with the Settings copy and records nothing")
  func deniedPermissionFails() async {
    let harness = Harness(transcript: "never", permissionGranted: false)
    let feature = harness.feature

    await feature.start()

    #expect(feature.state.phase == .failed("Microphone access is off. Turn it on in Settings."))
    #expect(feature.showsSettingsAction)
    #expect(await harness.recorder.startCount == 0)
    // Nothing was activated, so nothing may be deactivated: a stray
    // `setActive(false)` here would interrupt whatever else is playing.
    #expect(harness.session.activations == 0)
    #expect(harness.session.deactivations == 0)
  }

  @Test("a transcription failure discards the recording and shows the provider's message")
  func transcriptionFailureDiscardsTheRecording() async {
    let harness = Harness(
      result: .failure(
        GatewayError.speech(code: "provider_error", message: "Whisper is down", retryable: true)
      )
    )
    let feature = harness.feature

    await feature.start()
    let text = await feature.finish()

    #expect(text == nil)
    #expect(feature.state.phase == .failed("Whisper is down"))
    #expect(harness.inserted.texts.isEmpty)
    // The audio is gone — `stop()` read and deleted the clip — so the only
    // retry is a fresh recording.
    #expect(await harness.recorder.stopCount == 1)
    #expect(feature.showsSettingsAction == false)
    #expect(harness.session.deactivations == 1)
  }

  @Test("a gateway without speech configured gets its own copy, not the raw code")
  func unavailableSpeechErrorCopy() async {
    let harness = Harness(
      result: .failure(
        GatewayError.speech(code: "unavailable", message: "speech is not configured", retryable: false)
      )
    )

    await harness.feature.start()
    _ = await harness.feature.finish()

    #expect(harness.feature.state.phase == .failed("Speech isn't set up on your gateway yet."))
  }

  @Test("a rejected provider key reads as a key problem, never as a pairing problem")
  func unauthorizedSpeechErrorCopy() async {
    let harness = Harness(
      result: .failure(
        GatewayError.speech(code: "unauthorized", message: "401", retryable: false)
      )
    )

    await harness.feature.start()
    _ = await harness.feature.finish()

    #expect(
      harness.feature.state.phase == .failed("Your gateway's speech provider key was rejected.")
    )
  }

  @Test("a non-speech error gets a plain sentence, not GatewayError's debug description")
  func nonSpeechErrorCopy() async {
    let harness = Harness(result: .failure(GatewayError.gatewayOffline))

    await harness.feature.start()
    _ = await harness.feature.finish()

    #expect(harness.feature.state.phase == .failed("Transcription failed. Try again."))
  }

  @Test("a silent clip says nothing was heard rather than inserting an empty string")
  func emptyTranscriptFails() async {
    let harness = Harness(transcript: "   \n ")

    await harness.feature.start()
    let text = await harness.feature.finish()

    #expect(text == nil)
    #expect(harness.feature.state.phase == .failed("Nothing was heard."))
    #expect(harness.inserted.texts.isEmpty)
  }

  @Test("the clip is cut and uploaded at 60 seconds without the user tapping anything")
  func autoFinishesAtTheCap() async {
    let harness = Harness(transcript: "cut at the cap")
    let feature = harness.feature
    await feature.start()

    await harness.clock.setNow(harness.start.addingTimeInterval(60))
    harness.recorder.emit(0.2)

    await expectEventually("the cap to finish the recording") {
      harness.inserted.texts.isEmpty == false
    }
    #expect(harness.inserted.texts == ["cut at the cap"])
    #expect(await harness.recorder.stopCount == 1)
    #expect(feature.state.phase == .idle)
  }

  @Test("cancelling discards the audio without uploading it")
  func cancelDiscardsTheRecording() async {
    let harness = Harness(transcript: "never uploaded")
    let feature = harness.feature
    await feature.start()

    await feature.cancel()

    #expect(feature.state.phase == .idle)
    #expect(await harness.recorder.cancelCount == 1)
    #expect(await harness.recorder.stopCount == 0)
    #expect(await harness.transcriber.callCount == 0)
    #expect(harness.session.deactivations == 1)
  }

  @Test("a phone call interrupts the recording instead of silently recording nothing")
  func interruptionCancelsTheRecording() async {
    let harness = Harness(transcript: "never uploaded")
    let feature = harness.feature
    await feature.start()

    harness.interruptions.begin()

    await expectEventually("the interruption to end the recording") {
      feature.state.phase == .failed("Recording was interrupted.")
    }
    #expect(await harness.recorder.cancelCount == 1)
    #expect(await harness.recorder.stopCount == 0)
    #expect(harness.session.deactivations == 1)
  }

  @Test("recording again cancels the previous upload so its late reply is never inserted")
  func startingAgainCancelsTheInFlightTranscription() async {
    let gate = TestGate()
    let harness = Harness(transcript: "stale", waitingOn: gate)
    let feature = harness.feature

    await feature.start()
    let upload = Task { await feature.finish() }
    await gate.waitUntilWaiting()
    #expect(feature.state.phase == .uploading)

    // The user gave up on the upload and started talking again.
    await feature.start()
    #expect(feature.state.phase == .recording(elapsed: .zero, level: 0))
    await gate.release()
    _ = await upload.value

    #expect(harness.inserted.texts.isEmpty, "a cancelled upload must not write to the draft")
    #expect(feature.state.phase == .recording(elapsed: .zero, level: 0))
    #expect(await harness.recorder.startCount == 2)
  }

  @Test("a failure is retried as a fresh recording")
  func retryAfterFailureRecordsAgain() async {
    let harness = Harness(transcript: "second try", permissionGranted: false)
    let feature = harness.feature
    await feature.start()
    #expect(feature.state.phase == .failed("Microphone access is off. Turn it on in Settings."))

    await harness.permission.setGranted(true)
    await feature.start()

    #expect(feature.state.phase == .recording(elapsed: .zero, level: 0))
    #expect(feature.showsSettingsAction == false)
  }

  @Test("acknowledging a failure clears it")
  func acknowledgingAFailureClearsIt() async {
    let harness = Harness(transcript: "x", permissionGranted: false)
    await harness.feature.start()

    harness.feature.acknowledgeFailure()

    #expect(harness.feature.state.phase == .idle)
  }

  @Test("a recorder that refuses to start says so instead of showing a dead bar")
  func recorderStartFailureFails() async {
    let harness = Harness(transcript: "x")
    await harness.recorder.setStartError(AudioRecorderError.couldNotStart)

    await harness.feature.start()

    #expect(harness.feature.state.phase == .failed("Dash couldn't start recording."))
    #expect(harness.session.deactivations == 1)
  }

  // MARK: - Pure presentation

  @Test(
    "the meter renormalises linear amplitude so speech is visible",
    arguments: [
      (Float(0), 0.0),
      (Float(0.0625), 0.25),
      (Float(0.125), 0.5),
      (Float(0.25), 1.0),
      (Float(0.9), 1.0),
    ]
  )
  func meterFraction(level: Float, expected: Double) {
    #expect(DictationFeature.meterFraction(for: level) == expected)
  }

  @Test(
    "the countdown reads mm:ss",
    arguments: [
      (Duration.seconds(60), "1:00"),
      (Duration.seconds(59), "0:59"),
      (Duration.seconds(5), "0:05"),
      (Duration.zero, "0:00"),
      (Duration.seconds(-3), "0:00"),
    ]
  )
  func countdownText(remaining: Duration, expected: String) {
    #expect(DictationFeature.countdownText(remaining: remaining) == expected)
  }

  // MARK: - Harness

  @MainActor
  private struct Harness {
    let start = Date(timeIntervalSince1970: 5_000)
    let recorder = FakeAudioRecorder()
    let permission: FakeSpeechPermission
    let transcriber: FakeSpeechTranscriber
    let session = FakeSpeechSessionControl()
    let interruptions = FakeInterruptionSource()
    let inserted = InsertionRecorder()
    let clock: TestAppClock
    let feature: DictationFeature

    init(
      transcript: String = "",
      result: Result<String, Error>? = nil,
      permissionGranted: Bool = true,
      waitingOn gate: TestGate? = nil
    ) {
      permission = FakeSpeechPermission(granted: permissionGranted)
      transcriber = FakeSpeechTranscriber(
        result: result ?? .success(transcript),
        gate: gate
      )
      clock = TestAppClock(now: start)
      let source = interruptions
      feature = DictationFeature(
        recorder: recorder,
        permission: permission,
        transcriber: transcriber,
        clock: clock,
        session: session,
        interruptions: { source.stream() }
      )
      let recorderOfInsertions = inserted
      feature.onInsert = { text in
        recorderOfInsertions.append(text)
      }
    }
  }
}

/// Polls a main-actor condition, so a test never depends on how many
/// `Task.yield()`s a meter task happens to need.
@MainActor
func expectEventually(
  _ description: String,
  timeout: Duration = .seconds(2),
  _ condition: @MainActor () -> Bool,
  sourceLocation: SourceLocation = #_sourceLocation
) async {
  let deadline = ContinuousClock().now.advanced(by: timeout)
  while ContinuousClock().now < deadline {
    if condition() { return }
    await Task.yield()
    try? await Task.sleep(for: .milliseconds(2))
  }
  Issue.record("Timed out waiting for \(description)", sourceLocation: sourceLocation)
}

@MainActor
final class InsertionRecorder {
  private(set) var texts: [String] = []

  func append(_ text: String) {
    texts.append(text)
  }
}

/// Stands in for `AudioRecorderService`. Reuses the real
/// `AudioLevelBroadcaster` so the fake cannot drift from the
/// fresh-stream-per-access contract `AudioRecording.level` promises.
actor FakeAudioRecorder: AudioRecording {
  nonisolated let levels = AudioLevelBroadcaster()
  nonisolated var level: AsyncStream<Float> { levels.stream }

  private(set) var startCount = 0
  private(set) var stopCount = 0
  private(set) var cancelCount = 0
  private(set) var isRunning = false
  private var startError: Error?
  private var stopResult: Result<Data, Error> = .success(Data([0x01, 0x02, 0x03]))

  func setStartError(_ error: Error?) {
    startError = error
  }

  func setStopResult(_ result: Result<Data, Error>) {
    stopResult = result
  }

  nonisolated func emit(_ level: Float) {
    levels.yield(level)
  }

  func start(maxDuration: Duration) async throws {
    guard isRunning == false else { throw AudioRecorderError.alreadyRecording }
    if let startError { throw startError }
    startCount += 1
    isRunning = true
  }

  func stop() async throws -> Data {
    guard isRunning else { throw AudioRecorderError.notRecording }
    stopCount += 1
    isRunning = false
    levels.finish()
    return try stopResult.get()
  }

  func cancel() async {
    cancelCount += 1
    isRunning = false
    levels.finish()
  }
}

actor FakeSpeechPermission: SpeechPermissionRequesting {
  private var granted: Bool
  private(set) var requests = 0

  init(granted: Bool) {
    self.granted = granted
  }

  func setGranted(_ value: Bool) {
    granted = value
  }

  func requestMicrophone() async -> Bool {
    requests += 1
    return granted
  }
}

actor FakeSpeechTranscriber: SpeechTranscribing {
  private let result: Result<String, Error>
  private let gate: TestGate?
  private(set) var callCount = 0
  private(set) var requests: [TranscriptionRequestDTO] = []

  init(result: Result<String, Error>, gate: TestGate? = nil) {
    self.result = result
    self.gate = gate
  }

  func transcribe(_ request: TranscriptionRequestDTO) async throws -> TranscriptionResponseDTO {
    callCount += 1
    requests.append(request)
    if let gate {
      await gate.wait()
    }
    try Task.checkCancellation()
    let text = try result.get()
    return TranscriptionResponseDTO(text: text, durationSeconds: nil)
  }
}

/// `SpeechAudioSession` writes to the process-wide `AVAudioSession`; a unit
/// test must not. A lock rather than an actor because the protocol's
/// requirements are synchronous.
final class FakeSpeechSessionControl: SpeechSessionControlling, @unchecked Sendable {
  private let lock = NSLock()
  private var activationCount = 0
  private var deactivationCount = 0
  private var activationError: Error?

  var activations: Int { lock.withLock { activationCount } }
  var deactivations: Int { lock.withLock { deactivationCount } }

  func setActivationError(_ error: Error?) {
    lock.withLock { activationError = error }
  }

  func activateRecording() throws {
    let error = lock.withLock { () -> Error? in
      activationCount += 1
      return activationError
    }
    if let error { throw error }
  }

  func deactivate() {
    lock.withLock { deactivationCount += 1 }
  }
}

/// A hand-driven stand-in for `AVAudioSession.interruptionNotification`.
/// Nonisolated, like the real source: `SpeechInterruptionSource` is a
/// synchronous `@Sendable` factory, so it cannot hop to the main actor.
final class FakeInterruptionSource: @unchecked Sendable {
  private let lock = NSLock()
  private var continuations: [AsyncStream<Void>.Continuation] = []

  func stream() -> AsyncStream<Void> {
    let pair = AsyncStream<Void>.makeStream(of: Void.self)
    lock.withLock { continuations.append(pair.continuation) }
    return pair.stream
  }

  func begin() {
    for continuation in lock.withLock({ continuations }) { continuation.yield(()) }
  }
}
