import Foundation
import Testing

@testable import Dash

/// What the reducer cannot express: which task is running, what actually
/// reaches the socket, the order audio chunks reach the player, and when the
/// audio session is released (speech Phase B, Task B9).
@Suite("Voice mode feature")
@MainActor
struct VoiceModeFeatureTests {
  // MARK: - Starting

  @Test("start asks for the microphone and opens the session")
  func startOpensTheSession() async {
    let harness = Harness()

    await harness.feature.start()

    #expect(await harness.permission.requests == 1)
    await expectEventuallyAsync("voice_start to be sent") {
      await harness.transport.calls.contains(.start(id: "voice-1"))
    }
    #expect(harness.feature.state.phase == .connecting)
    await expectEventuallyAsync("capture to be running") { await harness.capture.isRunning }
  }

  @Test("a denied microphone ends before anything is sent")
  func deniedMicrophoneEnds() async {
    let harness = Harness(granted: false)

    await harness.feature.start()

    #expect(harness.feature.state.phase == .ended(reason: VoiceModeState.permissionDeniedMessage))
    #expect(harness.feature.state.error == VoiceModeState.permissionDeniedMessage)
    #expect(await harness.transport.calls.isEmpty)
    #expect(await harness.capture.isRunning == false)
  }

  @Test("a capture that will not start ends with a message the user can act on")
  func captureFailureEnds() async {
    let harness = Harness()
    await harness.capture.setStartError(AudioCaptureError.couldNotStart)

    await harness.feature.start()

    await expectEventuallyAsync("the session to end") {
      harness.feature.state.phase.isEnded
    }
    #expect(harness.feature.state.error == VoiceModeState.couldNotStartMessage)
  }

  @Test("a socket that refuses voice_start ends the session")
  func refusedStartEnds() async {
    let harness = Harness()
    await harness.transport.setStartError(GatewayError.transport("offline"))

    await harness.feature.start()

    await expectEventuallyAsync("the session to end") {
      harness.feature.state.phase.isEnded
    }
    #expect(harness.feature.state.error == VoiceModeState.couldNotStartMessage)
  }

  @Test("prepare finishes before the microphone is armed")
  func prepareRunsBeforeCapture() async {
    let harness = Harness()
    let order = OrderRecorder()
    harness.feature.prepare = {
      // `ReadAloudFeature.stop()` deactivates the one process-wide audio
      // session; landing after the capture armed it would evict the capture.
      await order.record("prepare")
    }
    await harness.capture.setOnStart { await order.record("capture") }

    await harness.feature.start()
    await expectEventuallyAsync("capture to be running") { await harness.capture.isRunning }

    #expect(await order.events == ["prepare", "capture"])
  }

  @Test("a session ended during prepare never arms the microphone")
  func endedDuringPrepareNeverStarts() async {
    let harness = Harness()
    harness.feature.prepare = { [weak feature = harness.feature] in
      feature?.transportLost()
    }

    await harness.feature.start()

    #expect(harness.feature.state.phase.isEnded)
    #expect(await harness.capture.isRunning == false)
    #expect(await harness.transport.calls.isEmpty)
  }

  // MARK: - Audio

  @Test("captured audio is dropped until the gateway says it is listening")
  func audioWaitsForListening() async {
    let harness = await Harness.started()

    await harness.capture.yield(Data([0x01]))
    await harness.capture.yield(Data([0x02]))
    // Nothing may go out while the gateway is still checking its provider.
    #expect(await harness.transport.audioCalls.isEmpty)

    harness.feature.receive(.voiceState(id: "voice-1", state: .listening, turnId: nil))
    await harness.capture.yield(Data([0x03]))

    await expectEventuallyAsync("the third frame to be sent") {
      await harness.transport.audioCalls.count == 1
    }
    // `seq` starts at 0 and counts SENT frames — the dropped ones never
    // existed as far as the gateway is concerned.
    #expect(await harness.transport.audioCalls == [.audio(seq: 0, pcm: Data([0x03]))])
  }

  @Test("seq increases monotonically across frames")
  func seqIncreases() async {
    let harness = await Harness.started()
    harness.feature.receive(.voiceState(id: "voice-1", state: .listening, turnId: nil))

    for byte in UInt8(1)...3 { await harness.capture.yield(Data([byte])) }

    await expectEventuallyAsync("three frames") { await harness.transport.audioCalls.count == 3 }
    #expect(
      await harness.transport.audioCalls == [
        .audio(seq: 0, pcm: Data([0x01])),
        .audio(seq: 1, pcm: Data([0x02])),
        .audio(seq: 2, pcm: Data([0x03])),
      ]
    )
  }

  @Test("muting keeps the microphone running but stops sending")
  func mutingStopsSendingWithoutStoppingCapture() async {
    let harness = await Harness.started()
    harness.feature.receive(.voiceState(id: "voice-1", state: .listening, turnId: nil))

    await harness.feature.toggleMute()

    #expect(await harness.transport.calls.contains(.mute(true)))
    #expect(await harness.capture.isRunning, "the orb still moves while muted")
    await harness.capture.yield(Data([0x09]))
    await Task.yield()
    #expect(await harness.transport.audioCalls.isEmpty)

    await harness.feature.toggleMute()
    #expect(await harness.transport.calls.contains(.mute(false)))
    await harness.capture.yield(Data([0x0A]))
    await expectEventuallyAsync("sending to resume") {
      await harness.transport.audioCalls.count == 1
    }
  }

  @Test("the microphone level reaches the orb without touching the session state")
  func levelsReachTheOrb() async {
    let harness = await Harness.started()
    let before = harness.feature.state

    harness.levels.yield(0.6)

    await expectEventuallyAsync("the level to land") { harness.feature.level == 0.6 }
    // `level` is its own observable property, NOT part of `VoiceModeState`:
    // the meter writes 10-20 times a second, and folding it into the state
    // would re-render the captions, the state line and both controls on every
    // one of them.
    #expect(harness.feature.state == before)
  }

  @Test("the meter stops writing once the session has ended")
  func levelsStopAtTheEnd() async {
    let harness = await Harness.started()
    harness.levels.yield(0.6)
    await expectEventuallyAsync("the level to land") { harness.feature.level == 0.6 }

    await harness.feature.stop()
    harness.levels.yield(0.9)
    await Task.yield()

    #expect(harness.feature.level == 0.6)
  }

  // MARK: - Playback

  @Test("pcm chunks reach the player in order, at the frame's sample rate")
  func pcmChunksPlayInOrder() async {
    let harness = await Harness.started()

    for seq in 0..<3 {
      harness.feature.receive(
        .voiceSpeech(
          id: "voice-1",
          seq: seq,
          audio: Data([UInt8(seq)]).base64EncodedString(),
          format: "pcm16",
          sampleRate: 24_000,
          text: "chunk\(seq) "
        )
      )
    }

    await expectEventuallyAsync("three chunks enqueued") {
      await harness.player.enqueued.count == 3
    }
    let enqueued = await harness.player.enqueued
    #expect(enqueued.map(\.0) == [Data([0x00]), Data([0x01]), Data([0x02])])
    #expect(enqueued.allSatisfy { $0.1 == 24_000 })
    #expect(harness.feature.state.assistantCaption == "chunk0 chunk1 chunk2 ")
  }

  @Test("an mp3 chunk goes to the clip player instead")
  func mp3ChunksPlayAsClips() async {
    let harness = await Harness.started()
    let audio = Data([0x49, 0x44, 0x33])

    harness.feature.receive(
      .voiceSpeech(
        id: "voice-1",
        seq: 0,
        audio: audio.base64EncodedString(),
        format: "mp3",
        sampleRate: nil,
        text: "Hello"
      )
    )

    await expectEventuallyAsync("the clip to start") { await harness.player.played == [audio] }
    #expect(await harness.player.enqueued.isEmpty)
    // `FakeAudioPlayer.playMP3` hangs until the clip ends — release it so the
    // harness does not leave a task behind.
    await harness.player.finish()
  }

  @Test("the gateway's own barge-in flushes what is already buffered")
  func serverBargeInFlushesPlayback() async {
    let harness = await Harness.started()
    harness.feature.receive(.voiceState(id: "voice-1", state: .speaking, turnId: "turn-1"))
    harness.feature.receive(
      .voiceSpeech(
        id: "voice-1",
        seq: 0,
        audio: Data([0x01]).base64EncodedString(),
        format: "pcm16",
        sampleRate: 24_000,
        text: "Sunny"
      )
    )
    await expectEventuallyAsync("a chunk to be buffered") {
      await harness.player.enqueued.count == 1
    }

    harness.feature.receive(.voiceState(id: "voice-1", state: .listening, turnId: nil))

    await expectEventuallyAsync("playback to be flushed") { await harness.player.flushCount == 1 }
    #expect(harness.feature.state.assistantCaption.isEmpty)
  }

  @Test("tapping the orb while speaking silences this device")
  func orbTapFlushesPlayback() async {
    let harness = await Harness.started()
    harness.feature.receive(.voiceState(id: "voice-1", state: .speaking, turnId: "turn-1"))

    harness.feature.tapOrb()

    await expectEventuallyAsync("playback to be flushed") { await harness.player.flushCount == 1 }
    // Nothing new is sent: the gateway's VAD owns barge-in.
    #expect(await harness.transport.calls.contains(.stop(id: "voice-1")) == false)
  }

  @Test("a flush cannot truncate the utterance that follows it")
  func flushCannotTruncateTheNextUtterance() async {
    let harness = await Harness.started()
    let first = Data([0x01])
    let second = Data([0x02])
    harness.feature.receive(.voiceState(id: "voice-1", state: .speaking, turnId: "turn-1"))
    harness.feature.receive(speech(audio: first, text: "Sunny"))
    await expectEventuallyAsync("the first chunk") { await harness.player.enqueued.count == 1 }

    // Park the effect chain on a slow send, so a flush that travelled on it
    // could not run until the send cleared.
    let gate = TestGate()
    harness.feature.onStartLocalTurn = { _, _ in await gate.wait() }
    harness.feature.receive(
      .voiceTranscript(id: "voice-1", text: "and tomorrow?", final: true, turnId: "turn-2")
    )
    await gate.waitUntilWaiting()

    // The user talks over the assistant; the next turn's first chunk follows
    // immediately behind it.
    harness.feature.receive(.voiceState(id: "voice-1", state: .listening, turnId: nil))
    harness.feature.receive(.voiceState(id: "voice-1", state: .speaking, turnId: "turn-2"))
    harness.feature.receive(speech(audio: second, text: "Rain"))

    await expectEventuallyAsync("the second chunk") { await harness.player.enqueued.count == 2 }
    #expect(
      await harness.player.events == [
        .enqueue(first), .flush, .stop, .enqueue(second),
      ],
      "the flush has to land BETWEEN the two utterances, not after both"
    )
    await gate.release()
  }

  // MARK: - Transcripts

  @Test("a transcript carrying a turn id starts the optimistic row exactly once")
  func transcriptStartsTheLocalTurn() async {
    let harness = await Harness.started()

    // The queued-utterance pair: the turn-id-less frame first, then the real
    // one when the turn starts.
    harness.feature.receive(
      .voiceTranscript(id: "voice-1", text: "what's the weather", final: true, turnId: nil)
    )
    harness.feature.receive(
      .voiceTranscript(id: "voice-1", text: "what's the weather", final: true, turnId: "turn-9")
    )

    await expectEventuallyAsync("one local turn") { harness.localTurns.count == 1 }
    #expect(harness.localTurns.first?.0 == "turn-9")
    #expect(harness.localTurns.first?.1 == "what's the weather")
    #expect(harness.feature.state.userCaption == "what's the weather")
  }

  // MARK: - Session identity

  @Test("frames from another voice session are ignored")
  func framesFromAnotherSessionAreIgnored() async {
    let harness = await Harness.started()

    // The previous session's `replaced` stop, arriving after this one opened.
    harness.feature.receive(.voiceStopped(id: "voice-0", reason: .replaced))

    #expect(harness.feature.state.phase == .connecting)
    #expect(harness.dismissals == 0)
  }

  // MARK: - Ending

  @Test("stop tells the gateway, stops the microphone and releases the route")
  func stopTearsEverythingDown() async {
    let harness = await Harness.started()

    await harness.feature.stop()

    #expect(await harness.transport.calls.contains(.stop(id: "voice-1")))
    #expect(await harness.capture.isRunning == false)
    #expect(await harness.player.flushCount >= 1)
    #expect(harness.session.deactivations == 1)
    #expect(harness.dismissals == 1)
  }

  @Test("stop does not wait for a gateway that never acknowledges it")
  func stopDoesNotWaitForTheGateway() async {
    let harness = await Harness.started()
    await harness.transport.setStopHangs(true)

    await harness.feature.stop()

    // `voice_stop` is best-effort by design (Task B6: one sent before the
    // session was live produces no frame at all). Waiting for it would leave
    // the cover on screen with a live microphone behind it.
    #expect(harness.dismissals == 1)
    #expect(await harness.capture.isRunning == false)
    #expect(harness.session.deactivations == 1)
  }

  @Test("an ending during capture start still releases the microphone and the route")
  func endingDuringCaptureStartReleasesEverything() async {
    let harness = Harness()
    let gate = TestGate()
    await harness.capture.setStartGate(gate)

    await harness.feature.start()
    await gate.waitUntilWaiting()
    // The socket drops while `AudioCaptureService.start()` is still arming
    // `.playAndRecord` — the route may already be live even though nothing
    // here has a stream to show for it.
    harness.feature.transportLost()
    await gate.release()

    await expectEventuallyAsync("the microphone to be stopped") {
      await harness.capture.stopCount == 1
    }
    #expect(harness.session.deactivations >= 1)
    #expect(await harness.capture.isRunning == false)
  }

  @Test("a capture that throws after arming the route still releases it")
  func captureFailureReleasesTheRoute() async {
    let harness = Harness()
    // `AudioCaptureService.start()` activates the session and THEN installs
    // the tap; a tap that throws leaves the route armed with nobody on it.
    await harness.capture.setStartError(AudioCaptureError.couldNotStart)

    await harness.feature.start()

    await expectEventuallyAsync("the route to be released") {
      harness.session.deactivations == 1
    }
  }

  @Test("stopping twice is harmless")
  func stopIsIdempotent() async {
    let harness = await Harness.started()

    await harness.feature.stop()
    await harness.feature.stop()

    let stops = await harness.transport.calls.filter { $0 == .stop(id: "voice-1") }
    #expect(stops.count == 1)
  }

  @Test("voice_stopped ends the session without sending voice_stop back")
  func voiceStoppedEndsWithoutSending() async {
    let harness = await Harness.started()

    harness.feature.receive(.voiceStopped(id: "voice-1", reason: .provider))

    #expect(harness.feature.state.phase == .ended(reason: VoiceModeState.providerStoppedMessage))
    await expectEventuallyAsync("the microphone to stop") { await harness.capture.isRunning == false }
    #expect(await harness.transport.calls.contains(.stop(id: "voice-1")) == false)
    await expectEventuallyAsync("the cover to dismiss") { harness.dismissals == 1 }
  }

  @Test("an interrupted capture ends the session AND tells the gateway")
  func captureInterruptionEnds() async {
    let harness = await Harness.started()

    // Task B8: the stream FINISHING is the interruption signal.
    await harness.capture.interrupt()

    await expectEventuallyAsync("the session to end") { harness.feature.state.phase.isEnded }
    #expect(harness.feature.state.phase == .ended(reason: VoiceModeState.microphoneStoppedMessage))
    await expectEventuallyAsync("voice_stop to be sent") {
      await harness.transport.calls.contains(.stop(id: "voice-1"))
    }
    #expect(harness.session.deactivations == 1)
  }

  @Test("a send that fails ends the session without a voice_stop nobody can deliver")
  func transportFailureEnds() async {
    let harness = await Harness.started()
    harness.feature.receive(.voiceState(id: "voice-1", state: .listening, turnId: nil))
    await harness.transport.setAudioError(GatewayError.transport("offline"))

    await harness.capture.yield(Data([0x01]))

    await expectEventuallyAsync("the session to end") { harness.feature.state.phase.isEnded }
    #expect(harness.feature.state.phase == .ended(reason: VoiceModeState.connectionLostMessage))
    #expect(await harness.transport.calls.contains(.stop(id: "voice-1")) == false)
  }

  @Test("a socket that goes away ends the session, even while muted")
  func transportLossEndsAMutedSession() async {
    let harness = await Harness.started()
    harness.feature.receive(.voiceState(id: "voice-1", state: .listening, turnId: nil))
    await harness.feature.toggleMute()

    // Nothing on the wire says the session is gone: a muted session sends no
    // audio, so there is no send to fail. `ChatFeature` has to say so.
    harness.feature.transportLost()

    #expect(harness.feature.state.phase == .ended(reason: VoiceModeState.connectionLostMessage))
    await expectEventuallyAsync("the microphone to stop") {
      await harness.capture.isRunning == false
    }
    // Nothing is sent down a socket that is already gone.
    #expect(await harness.transport.calls.contains(.stop(id: "voice-1")) == false)
    #expect(harness.session.deactivations == 1)
  }

  // MARK: - Haptics

  @Test("the phase changes are felt, and so is an error")
  func hapticsFireOnTheThreeMoments() async {
    let harness = await Harness.started()

    harness.feature.receive(.voiceState(id: "voice-1", state: .listening, turnId: nil))
    harness.feature.receive(.voiceState(id: "voice-1", state: .thinking, turnId: "turn-1"))
    harness.feature.receive(.voiceState(id: "voice-1", state: .speaking, turnId: "turn-1"))
    harness.feature.receive(.voiceError(id: "voice-1", code: "provider", error: "It broke"))

    #expect(harness.haptics.events == [.impact(.light), .impact(.medium), .error])
  }

  private func speech(audio: Data, text: String) -> MobileWSServerFrame {
    .voiceSpeech(
      id: "voice-1",
      seq: 0,
      audio: audio.base64EncodedString(),
      format: "pcm16",
      sampleRate: 24_000,
      text: text
    )
  }

  // MARK: - Harness

  @MainActor
  final class Harness {
    let feature: VoiceModeFeature
    let transport = FakeVoiceTransport()
    let capture = FakeAudioCapture()
    let player = FakeAudioPlayer()
    let permission: FakeSpeechPermission
    let session = FakeSpeechSessionControl()
    let haptics = FakeVoiceHaptics()
    let levels = LevelSource()
    private(set) var localTurns: [(String, String)] = []
    private(set) var dismissals = 0

    init(granted: Bool = true) {
      permission = FakeSpeechPermission(granted: granted)
      let source = levels
      feature = VoiceModeFeature(
        id: "voice-1",
        agentID: "agent-1",
        conversationID: "conv-1",
        transport: transport,
        capture: capture,
        player: player,
        haptics: haptics,
        permission: permission,
        session: session,
        levels: { source.stream() },
        clock: TestAppClock(now: Date(timeIntervalSince1970: 1_000))
      )
      feature.onStartLocalTurn = { [weak self] turnID, text in
        self?.localTurns.append((turnID, text))
      }
      feature.onDismiss = { [weak self] in
        self?.dismissals += 1
      }
    }

    /// A session that has started and whose capture is live — the state every
    /// test below "start" begins from.
    static func started() async -> Harness {
      let harness = Harness()
      await harness.feature.start()
      await expectEventuallyAsync("capture to be running") { await harness.capture.isRunning }
      await expectEventuallyAsync("the level meter to be subscribed") { harness.levels.isSubscribed }
      return harness
    }
  }
}

// MARK: - Doubles

@MainActor
final class FakeVoiceHaptics: VoiceHaptics {
  enum Event: Equatable {
    case impact(VoiceHapticWeight)
    case error
  }

  private(set) var events: [Event] = []

  func impact(_ weight: VoiceHapticWeight) {
    events.append(.impact(weight))
  }

  func error() {
    events.append(.error)
  }
}

/// A microphone under the test's control: `yield` pushes one 100 ms frame,
/// `interrupt` finishes the stream the way a phone call does.
actor FakeAudioCapture: AudioCapturing {
  private var continuation: AsyncStream<Data>.Continuation?
  private var startError: Error?
  private(set) var isRunning = false
  private(set) var stopCount = 0

  private var onStart: (@Sendable () async -> Void)?
  private var startGate: TestGate?

  /// Parks inside `start()` until the test releases it, so a test can end the
  /// session while the microphone is still coming up.
  func setStartGate(_ gate: TestGate) {
    startGate = gate
  }

  func setStartError(_ error: Error?) {
    startError = error
  }

  /// Runs inside `start()`, so a test can observe what has and has not
  /// happened by the time the microphone is armed.
  func setOnStart(_ body: @escaping @Sendable () async -> Void) {
    onStart = body
  }

  func start() async throws -> AsyncStream<Data> {
    if let startError { throw startError }
    await onStart?()
    if let startGate { await startGate.wait() }
    guard isRunning == false else { throw AudioCaptureError.alreadyCapturing }
    isRunning = true
    let pair = AsyncStream<Data>.makeStream()
    continuation = pair.continuation
    return pair.stream
  }

  func stop() async {
    guard isRunning else { return }
    isRunning = false
    stopCount += 1
    continuation?.finish()
    continuation = nil
  }

  func yield(_ frame: Data) {
    continuation?.yield(frame)
  }

  /// The interruption path: the stream ends on its own, with `isRunning`
  /// still true — nobody called `stop()`.
  func interrupt() {
    continuation?.finish()
    continuation = nil
  }
}

/// `AudioCaptureService.levels` behind the feature's closure seam. Lock-guarded
/// rather than actor-isolated because the seam is a plain `@Sendable` closure,
/// called from whatever context the feature's capture loop is on.
final class LevelSource: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: AsyncStream<Float>.Continuation?

  /// Whether the feature has taken its stream yet. The feature subscribes
  /// only once `capture.start()` has returned (Task B8's rule), so a test
  /// that yields before that would push into nothing.
  var isSubscribed: Bool { lock.withLock { continuation != nil } }

  func stream() -> AsyncStream<Float> {
    let pair = AsyncStream<Float>.makeStream()
    lock.withLock { continuation = pair.continuation }
    return pair.stream
  }

  func yield(_ level: Float) {
    lock.withLock { continuation }?.yield(level)
  }
}

enum FakeVoiceTransportCall: Equatable, Sendable {
  case start(id: String)
  case audio(seq: Int, pcm: Data)
  case mute(Bool)
  case stop(id: String)
}

actor FakeVoiceTransport: ChatFeatureTransporting {
  private(set) var calls: [FakeVoiceTransportCall] = []
  private var startError: Error?
  private var audioError: Error?
  private let pair = AsyncThrowingStream<ChatConnectionEvent, Error>.makeStream()

  var audioCalls: [FakeVoiceTransportCall] {
    calls.filter { if case .audio = $0 { true } else { false } }
  }

  func setStartError(_ error: Error?) {
    startError = error
  }

  func setAudioError(_ error: Error?) {
    audioError = error
  }

  func voiceStart(id: String, agentID: String, conversationID: String) async throws {
    if let startError { throw startError }
    calls.append(.start(id: id))
  }

  func voiceAudio(id: String, seq: Int, pcm: Data) async throws {
    if let audioError { throw audioError }
    calls.append(.audio(seq: seq, pcm: pcm))
  }

  func voiceMute(id: String, muted: Bool) async throws {
    calls.append(.mute(muted))
  }

  private var stopHangs = false

  /// A `voice_stop` the gateway never acknowledges — a socket already on its
  /// way out is exactly when that happens.
  func setStopHangs(_ value: Bool) {
    stopHangs = value
  }

  func voiceStop(id: String) async throws {
    calls.append(.stop(id: id))
    if stopHangs { try? await Task.sleep(for: .seconds(60)) }
  }

  // Chat traffic: never exercised by voice mode, but the protocol is one.
  func events() async -> AsyncThrowingStream<ChatConnectionEvent, Error> { pair.stream }
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
  func suspendForDetachment() async {}
  func shutdown() async {}
}

/// Orders two things that happen on different tasks.
actor OrderRecorder {
  private(set) var events: [String] = []

  func record(_ event: String) {
    events.append(event)
  }
}
