import Foundation
import Observation
import UIKit

/// The three moments in voice mode the user cannot see happening, behind a
/// protocol so a unit test can assert on them — `UIFeedbackGenerator` does
/// nothing in the simulator and says nothing about whether it was asked.
@MainActor
protocol VoiceHaptics {
  func impact(_ weight: VoiceHapticWeight)
  func error()
}

enum VoiceHapticWeight: Equatable, Sendable {
  case light
  case medium
}

struct SystemVoiceHaptics: VoiceHaptics {
  func impact(_ weight: VoiceHapticWeight) {
    let style: UIImpactFeedbackGenerator.FeedbackStyle =
      switch weight {
      case .light: .light
      case .medium: .medium
      }
    UIImpactFeedbackGenerator(style: style).impactOccurred()
  }

  func error() {
    UINotificationFeedbackGenerator().notificationOccurred(.error)
  }
}

/// One hands-free voice session (speech Phase B, Task B9).
///
/// Owns the microphone, the speaker, the socket frames and the audio session;
/// the state machine itself lives in `VoiceModeReducer`, which is pure and
/// tested separately. What this adds is the part a reducer cannot express.
///
/// Four rules earned the shape below:
///
/// 1. **Two queues, not one.** Session frames (`voice_start`, `voice_mute`,
///    `voice_stop`) are serialized on `effectChain` so two fast mute taps
///    cannot reach the gateway out of order. Playback gets its OWN chain,
///    because `AudioPlaying.playMP3` returns only when the clip ENDS: a
///    barge-in queued behind a clip on one shared chain could never
///    interrupt the clip it was meant to cut short.
/// 2. **Audio bypasses both.** Capture frames go straight to the transport
///    from the capture loop with their own `seq`, since an actor already
///    serializes them and putting 100 ms frames through a task chain would
///    add a hop to every one of them.
/// 3. **Every ending runs through `finish()`.** `voice_stopped`, a lost
///    socket, an interrupted capture, the close button, a denied microphone:
///    all of them stop capture, flush playback and DEACTIVATE the audio
///    session. Voice mode's session is `.playAndRecord` with the speaker
///    routed — leaving it armed would duck every other app on the phone.
/// 4. **The stream finishing is ambiguous, so order matters.** Task B8's
///    capture stream finishes both when we stop it and when a phone call
///    takes the microphone away. `stop()` therefore applies `.stopRequested`
///    — which moves the phase to `.ended` — BEFORE it stops the capture, so
///    the resulting `.captureInterrupted` hits the reducer's terminal guard
///    instead of announcing an interruption that never happened.
@MainActor
@Observable
final class VoiceModeFeature: Identifiable {
  let id: String

  private(set) var state = VoiceModeState()

  /// The spoken turn's optimistic row. `ChatFeature` does exactly what
  /// `send()` does — `.sendStarted` plus `localTurnIDs` — so the hub's
  /// following `accepted` adopts the row rather than leaving an empty bubble
  /// and a composer blocked by "Active on another device".
  @ObservationIgnored var onStartLocalTurn: (@MainActor (String, String) async -> Void)?
  /// Take the cover down. `ChatFeature` clears its `voiceMode`, which is what
  /// the `.fullScreenCover(item:)` binding reads.
  @ObservationIgnored var onDismiss: (@MainActor () -> Void)?

  @ObservationIgnored private let agentID: String
  @ObservationIgnored private let conversationID: String
  @ObservationIgnored private let transport: any ChatFeatureTransporting
  @ObservationIgnored private let capture: any AudioCapturing
  @ObservationIgnored private let player: any AudioPlaying
  @ObservationIgnored private let haptics: any VoiceHaptics
  @ObservationIgnored private let permission: any SpeechPermissionRequesting
  @ObservationIgnored private let session: any SpeechSessionControlling
  /// `AudioCaptureService.levels` behind a closure, the same shape
  /// `SpeechInterruptionSource` uses: the meter is NOT part of
  /// `AudioCapturing` (Task B8 put it on the concrete actor), and a stream
  /// taken once at init would be dead for every capture after the first.
  @ObservationIgnored private let levels: @Sendable () -> AsyncStream<Float>
  @ObservationIgnored private let clock: any AppClock
  /// How long `.ended` stays on screen before the cover comes down. `nil`
  /// never dismisses — the UI-test scenarios use that so the `ended` surface
  /// can be looked at and photographed.
  @ObservationIgnored private let dismissDelay: Duration?

  @ObservationIgnored private var effectChain: Task<Void, Never>?
  @ObservationIgnored private var playbackChain: Task<Void, Never>?
  @ObservationIgnored private var playbackGeneration = 0
  @ObservationIgnored private var captureTask: Task<Void, Never>?
  @ObservationIgnored private var levelTask: Task<Void, Never>?
  @ObservationIgnored private var teardownTask: Task<Void, Never>?
  @ObservationIgnored private var dismissTask: Task<Void, Never>?
  @ObservationIgnored private var hasStarted = false
  @ObservationIgnored private var isCapturing = false
  @ObservationIgnored private var isSessionActive = false

  init(
    id: String,
    agentID: String,
    conversationID: String,
    transport: any ChatFeatureTransporting,
    capture: any AudioCapturing,
    player: any AudioPlaying,
    haptics: any VoiceHaptics = SystemVoiceHaptics(),
    permission: any SpeechPermissionRequesting = SystemSpeechPermission(),
    session: any SpeechSessionControlling = SystemSpeechSessionControl(),
    levels: @escaping @Sendable () -> AsyncStream<Float> = { AsyncStream { $0.finish() } },
    clock: any AppClock = SystemAppClock(),
    dismissDelay: Duration? = .seconds(1.5)
  ) {
    self.id = id
    self.agentID = agentID
    self.conversationID = conversationID
    self.transport = transport
    self.capture = capture
    self.player = player
    self.haptics = haptics
    self.permission = permission
    self.session = session
    self.levels = levels
    self.clock = clock
    self.dismissDelay = dismissDelay
  }

  // MARK: - Presentation

  var isMuted: Bool { state.phase == .muted }

  var isEnded: Bool { state.phase.isEnded }

  // MARK: - Commands

  /// Opens the session: permission, `voice_start`, then the microphone.
  ///
  /// `voice_start` goes first deliberately. Frames captured before the
  /// gateway answers with `voice_state listening` are dropped by
  /// `VoiceModeState.sendsAudio` (Task B6 — the gateway discards them anyway
  /// while it checks provider availability), so starting the microphone in
  /// parallel costs nothing and saves the user the round trip.
  func start() async {
    guard hasStarted == false else { return }
    hasStarted = true
    guard await permission.requestMicrophone() else {
      apply(.failed(VoiceModeState.permissionDeniedMessage))
      return
    }
    guard state.phase.isEnded == false else { return }
    apply(.started)
    captureTask = Task { [weak self] in
      await self?.runCapture()
    }
  }

  func toggleMute() async {
    apply(.muteToggled)
    await effectChain?.value
  }

  /// A tap on the orb. Silences what this device has already buffered; the
  /// gateway's VAD is what actually interrupts the assistant.
  func tapOrb() {
    apply(.orbTapped)
  }

  /// The close button, the cover's own dismissal, and the app going to the
  /// background all land here. Idempotent: the reducer's terminal guard turns
  /// a second call into a bare `.dismiss`.
  func stop() async {
    apply(.stopRequested)
    await effectChain?.value
    await teardownTask?.value
  }

  /// A `voice_*` frame from `ChatFeature`'s socket.
  func receive(_ frame: MobileWSServerFrame) {
    // A session id that is not ours belongs to a session this one REPLACED:
    // the gateway's `voice_start` handler stops the previous session first,
    // so its `voice_stopped { replaced }` can easily arrive after this
    // feature exists. Ending the new session on the old one's farewell would
    // close the cover the user just opened.
    guard frame.voiceSessionID == id else { return }
    apply(.frame(frame))
  }

  // MARK: - Internals

  private func apply(_ action: VoiceModeAction) {
    let previousPhase = state.phase
    let previousError = state.error
    let effects = VoiceModeReducer.reduce(state: &state, action: action)

    if state.phase != previousPhase {
      switch state.phase {
      case .listening: haptics.impact(.light)
      case .speaking: haptics.impact(.medium)
      case .connecting, .transcribing, .thinking, .muted, .ended: break
      }
      if state.phase.isEnded {
        finish(dismissesItself: effects.contains(.dismiss))
      }
    }
    if let error = state.error, error != previousError {
      haptics.error()
    }

    guard effects.isEmpty == false else { return }
    // Rule 1: `.play` is the one effect that can take seconds, so it gets its
    // own chain; everything else is a frame or a callback and stays in order
    // on the shared one.
    var queued: [VoiceModeEffect] = []
    for effect in effects {
      if case let .play(data, sampleRate, format) = effect {
        enqueuePlayback(data, sampleRate: sampleRate, format: format)
      } else {
        queued.append(effect)
      }
    }
    guard queued.isEmpty == false else { return }
    let previous = effectChain
    effectChain = Task { [weak self] in
      await previous?.value
      guard let self else { return }
      for effect in queued {
        await self.perform(effect)
      }
    }
  }

  private func perform(_ effect: VoiceModeEffect) async {
    switch effect {
    case .sendStart:
      do {
        try await transport.voiceStart(id: id, agentID: agentID, conversationID: conversationID)
      } catch {
        apply(.failed(VoiceModeState.couldNotStartMessage))
      }

    case .sendMute(let muted):
      // A mute that does not reach the gateway is not worth ending a session
      // over — the user can say so again, or close the cover.
      try? await transport.voiceMute(id: id, muted: muted)

    case .sendStop:
      // Never blocking, never fatal (Task B6): a `voice_stop` sent before the
      // session was live produces no frame at all, and the socket being gone
      // is exactly when this cannot be delivered anyway.
      try? await transport.voiceStop(id: id)

    case let .startLocalTurn(turnID, text):
      await onStartLocalTurn?(turnID, text)

    case .flushPlayback:
      await flushPlayback()

    case .dismiss:
      dismissTask?.cancel()
      dismissTask = nil
      onDismiss?()

    case .play:
      // Routed to the playback chain by `apply`; unreachable here.
      break
    }
  }

  // MARK: - Capture

  private func runCapture() async {
    let frames: AsyncStream<Data>
    do {
      frames = try await capture.start()
      isCapturing = true
      isSessionActive = true
    } catch {
      apply(.failed(VoiceModeState.couldNotStartMessage))
      return
    }
    // Task B8: subscribe AFTER `start()` returns and before `stop()` — a late
    // subscriber hangs until the next capture.
    observeLevels()

    var seq = 0
    for await pcm in frames {
      guard Task.isCancelled == false else { return }
      // Rule 2, and the two gates from the design: nothing before the
      // gateway's first `listening`, nothing while muted. The microphone
      // itself keeps running either way so the orb stays alive.
      guard state.sendsAudio else { continue }
      do {
        try await transport.voiceAudio(id: id, seq: seq, pcm: pcm)
        seq += 1
      } catch {
        apply(.transportLost)
        return
      }
    }
    // The stream ended without anyone asking: an interruption (Task B8). A
    // stream that ended because WE stopped it has already moved the phase to
    // `.ended`, and the reducer ignores this.
    guard Task.isCancelled == false else { return }
    apply(.captureInterrupted)
  }

  private func observeLevels() {
    let stream = levels()
    levelTask = Task { [weak self] in
      for await level in stream {
        guard let self, Task.isCancelled == false else { return }
        self.apply(.micLevel(level))
      }
    }
  }

  // MARK: - Playback

  private func enqueuePlayback(_ data: Data, sampleRate: Double?, format: String) {
    let generation = playbackGeneration
    let previous = playbackChain
    playbackChain = Task { [weak self] in
      await previous?.value
      guard let self, Task.isCancelled == false else { return }
      await self.playNow(data, sampleRate: sampleRate, format: format, generation: generation)
    }
  }

  private func playNow(
    _ data: Data,
    sampleRate: Double?,
    format: String,
    generation: Int
  ) async {
    // Flushed while this chunk waited its turn: it belongs to a sentence the
    // user has already talked over.
    guard generation == playbackGeneration else { return }
    if format == VoiceModeFeature.mp3Format {
      // Returns when the clip ENDS — which is what serializes the queue, and
      // what `flushPlayback`'s `stop()` cuts short.
      try? await player.playMP3(data)
    } else {
      await player.enqueuePCM(data, sampleRate: sampleRate ?? VoiceModeFeature.defaultSampleRate)
    }
  }

  private func flushPlayback() async {
    playbackGeneration &+= 1
    playbackChain?.cancel()
    playbackChain = nil
    await player.flush()
    // `flush()` drops the PCM queue; `stop()` is what releases a `playMP3`
    // still awaiting its clip.
    await player.stop()
  }

  /// The gateway's `voice_speech` carries a sample rate for PCM, but an older
  /// one may not; 24 kHz is what every TTS provider the gateway supports
  /// returns for `pcm16`.
  private static let defaultSampleRate: Double = 24_000
  private static let mp3Format = "mp3"

  // MARK: - Ending

  /// Rule 3: one place, every ending.
  private func finish(dismissesItself: Bool) {
    levelTask?.cancel()
    levelTask = nil
    // Cancelling from INSIDE `runCapture` (the interruption path) is safe:
    // the loop is already returning, and the guard after it checks.
    captureTask?.cancel()
    captureTask = nil
    teardownTask = Task { [weak self] in
      await self?.teardown()
    }
    guard dismissesItself == false else { return }
    scheduleDismiss()
  }

  private func teardown() async {
    await flushPlayback()
    if isCapturing {
      isCapturing = false
      await capture.stop()
    }
    guard isSessionActive else { return }
    isSessionActive = false
    // `AudioCaptureService` activates the session itself (`.playAndRecord`
    // with echo cancellation); nothing else will take it down.
    session.deactivate()
  }

  private func scheduleDismiss() {
    guard let dismissDelay else { return }
    dismissTask = Task { [weak self] in
      guard let clock = self?.clock else { return }
      try? await clock.sleep(for: dismissDelay)
      guard let self, Task.isCancelled == false else { return }
      self.onDismiss?()
    }
  }

  #if DEBUG
    /// Drives the cover into one state with canned captions, for
    /// `DASH_UI_TEST_VOICE` and `capture-surfaces.sh`. Through the REAL
    /// reducer, frame by frame, so a capture cannot show a state the app
    /// could not reach.
    func seedForUITesting(_ seed: String) {
      let question = "What's the weather in Singapore today?"
      receive(.voiceState(id: id, state: .listening, turnId: nil))
      receive(.voiceTranscript(id: id, text: question, final: false, turnId: nil))
      switch seed {
      case "listening":
        return
      case "muted":
        apply(.muteToggled)
      case "thinking":
        receive(.voiceTranscript(id: id, text: question, final: true, turnId: "voice-turn"))
        receive(.voiceState(id: id, state: .thinking, turnId: "voice-turn"))
      case "speaking":
        receive(.voiceTranscript(id: id, text: question, final: true, turnId: "voice-turn"))
        receive(.voiceState(id: id, state: .speaking, turnId: "voice-turn"))
        receive(
          .voiceSpeech(
            id: id,
            seq: 0,
            audio: "",
            format: "pcm16",
            sampleRate: 24_000,
            text: "It's 31 degrees and humid in Singapore, with thunderstorms likely this afternoon."
          )
        )
      case "ended":
        receive(.voiceStopped(id: id, reason: .client))
      default:
        return
      }
    }
  #endif
}

extension MobileWSServerFrame {
  /// The voice session id a `voice_*` frame carries, or nil for a chat-turn
  /// frame. Voice frames are keyed by SESSION, not by turn, which is why none
  /// of `ChatFeature`'s turn-id helpers can read them.
  var voiceSessionID: String? {
    switch self {
    case let .voiceState(id, _, _),
      let .voiceTranscript(id, _, _, _),
      let .voiceSpeech(id, _, _, _, _, _),
      let .voiceError(id, _, _),
      let .voiceStopped(id, _):
      id
    case .accepted, .event, .done, .error:
      nil
    }
  }
}
