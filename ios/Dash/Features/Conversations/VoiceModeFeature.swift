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
  /// The 0…1 RMS microphone level, for the orb and nothing else.
  ///
  /// Deliberately its OWN observable property rather than a field of
  /// `VoiceModeState`: the meter writes 10-20 times a second, and every write
  /// to the state invalidates the captions, the state line and both controls
  /// as well. Here, only the view that actually reads it re-renders.
  private(set) var level: Float = 0

  /// The spoken turn's optimistic row. `ChatFeature` does exactly what
  /// `send()` does — `.sendStarted` plus `localTurnIDs` — so the hub's
  /// following `accepted` adopts the row rather than leaving an empty bubble
  /// and a composer blocked by "Active on another device".
  @ObservationIgnored var onStartLocalTurn: (@MainActor (String, String) async -> Void)?
  /// Take the cover down. `ChatFeature` clears its `voiceMode`, which is what
  /// the `.fullScreenCover(item:)` binding reads.
  @ObservationIgnored var onDismiss: (@MainActor () -> Void)?
  /// Anything the owner must finish BEFORE the microphone is armed. Awaited
  /// at the very top of `start()`.
  ///
  /// It exists for one ordering hazard and one convenience.
  /// `ReadAloudFeature.stop()` ends with `session.deactivate()`, and there is
  /// one process-wide `AVAudioSession`: stopping a read in a detached task
  /// would let that `deactivate()` land AFTER `AudioCaptureService.start()`
  /// has activated `.playAndRecord`, tearing the route out from under a
  /// capture that had just armed it. Awaiting here makes the order total. The
  /// convenience is the socket — `ChatFeature.ensureConnected()`, the same
  /// call `send()` makes, so voice mode does not fail on a connection the
  /// chat would have re-established anyway.
  @ObservationIgnored var prepare: (@MainActor () async -> Void)?

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
  /// How many chunks have been handed to the playback chain, ever. Captured
  /// at enqueue time and compared again once the chunk has played: only the
  /// chunk that is still the LAST one enqueued is the tail of the chain, and
  /// only the tail acknowledges (F1). Waiting for a drain after every chunk
  /// would insert an audible gap between the PCM buffers of one sentence.
  @ObservationIgnored private var playbackEnqueueCount = 0
  @ObservationIgnored private var captureTask: Task<Void, Never>?
  @ObservationIgnored private var levelTask: Task<Void, Never>?
  @ObservationIgnored private var teardownTask: Task<Void, Never>?
  @ObservationIgnored private var dismissTask: Task<Void, Never>?
  @ObservationIgnored private var hasStarted = false
  @ObservationIgnored private var isCapturing = false

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
    await prepare?()
    guard state.phase.isEnded == false else { return }
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
    // `.dismiss` and the teardown both start inside `apply`; only the
    // teardown is worth waiting for, and `voice_stop` is not waited for at
    // all (see `sendStop`).
    apply(.stopRequested)
    await teardownTask?.value
  }

  /// The socket this session lives on went away.
  ///
  /// Fatal, and not only while reconnecting: the gateway holds its voice slot
  /// in the per-CONNECTION closure (`apps/gateway/src/chat-ws.ts`), so a new
  /// socket is a new closure with no session in it. Nothing on the wire says
  /// so — a muted session sends no audio at all, so without this the cover
  /// would sit on "Muted" forever and the first unmute would earn a
  /// `voice_error { invalid }`.
  func transportLost() {
    apply(.transportLost)
  }

  /// Lets go of everything the owner handed this session. Called once the
  /// session is over and the owner has dropped it, so nothing the closures
  /// captured outlives the session that stored them.
  func releaseCallbacks() {
    prepare = nil
    onStartLocalTurn = nil
    onDismiss = nil
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
    // Three effects never touch the serial chain, each for its own reason:
    //
    // - `.play`/`.flushPlayback` belong to the PLAYBACK chain (rule 1), and
    //   the flush in particular must take effect the instant the reducer says
    //   so. Queued behind a slow `voice_mute` send, it would flush the
    //   player AFTER the next utterance's first chunks had been buffered —
    //   truncating the reply the user had only just asked for.
    // - `.sendStop` is fire-and-forget (rule 5): the socket being gone is
    //   exactly when it cannot be delivered, and the cover must not wait for
    //   an acknowledgement that may never come.
    // - `.dismiss` is a synchronous callback with nothing to await.
    var queued: [VoiceModeEffect] = []
    for effect in effects {
      switch effect {
      case let .play(data, sampleRate, format):
        // `seq` is read here, synchronously, because the reducer has just
        // recorded it for the very frame that produced this effect — which
        // keeps the `.play` effect itself free of a field only the drain ack
        // uses.
        enqueuePlayback(data, sampleRate: sampleRate, format: format, seq: state.lastSpeechSeq)
      case .flushPlayback:
        flushPlayback()
      case .sendStop:
        sendStop()
      case .dismiss:
        dismissNow()
      case .sendStart, .sendMute, .startLocalTurn:
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

    case let .startLocalTurn(turnID, text):
      await onStartLocalTurn?(turnID, text)

    case .play, .flushPlayback, .sendStop, .dismiss:
      // Handled synchronously by `apply`, which never queues these.
      break
    }
  }

  /// Never blocking, never fatal (Task B6): a `voice_stop` sent before the
  /// session was live produces no frame at all, and the socket being gone is
  /// exactly when this cannot be delivered. Detached so that closing the
  /// cover is instant even when the gateway never answers.
  private func sendStop() {
    let transport = self.transport
    let id = self.id
    Task { try? await transport.voiceStop(id: id) }
  }

  private func dismissNow() {
    // A local copy first: `onDismiss` clears itself through `ChatFeature`,
    // and releasing the closure while it is still running is not safe.
    let dismiss = onDismiss
    dismissTask?.cancel()
    dismissTask = nil
    dismiss?()
  }

  // MARK: - Capture

  private func runCapture() async {
    let frames: AsyncStream<Data>
    do {
      frames = try await capture.start()
    } catch {
      // `AudioCaptureService.start()` activates the process-wide session
      // BEFORE it installs the tap, so a tap that throws leaves the route
      // armed. `.failed` runs the same `teardown()` every other ending does,
      // and that deactivates unconditionally.
      apply(.failed(VoiceModeState.couldNotStartMessage))
      return
    }
    isCapturing = true
    // An ending that landed WHILE `start()` was in flight already ran
    // `teardown()` — against a capture that did not exist yet, and against a
    // route this call has since re-armed. Tear down again, now that there is
    // something to tear down.
    guard Task.isCancelled == false, state.phase.isEnded == false else {
      await teardown()
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
        self.setLevel(level)
      }
    }
  }

  /// A sample buffered before the session ended can still arrive; a meter that
  /// twitched under an "ended" orb would say the microphone was still live.
  private func setLevel(_ value: Float) {
    guard state.phase.isEnded == false else { return }
    level = value
  }

  // MARK: - Playback

  private func enqueuePlayback(_ data: Data, sampleRate: Double?, format: String, seq: Int) {
    let generation = playbackGeneration
    playbackEnqueueCount &+= 1
    let position = playbackEnqueueCount
    let previous = playbackChain
    playbackChain = Task { [weak self] in
      await previous?.value
      guard let self, Task.isCancelled == false else { return }
      await self.playNow(data, sampleRate: sampleRate, format: format, generation: generation)
      await self.acknowledgeIfDrained(position: position, seq: seq, generation: generation)
    }
  }

  /// Tells the gateway that playback has drained, so it may leave `speaking`.
  ///
  /// Three guards, each for its own failure:
  ///
  /// 1. `position` — only the chunk that is still the last one enqueued is the
  ///    tail of the chain. Anything behind it is followed by more audio, and
  ///    acknowledging it would let the gateway advance mid-reply.
  /// 2. `generation` — a flush bumps it, and audio a barge-in DISCARDED was
  ///    never played. This is what keeps `flushPlayback` silent on the wire.
  /// 3. `awaitDrain()` — `enqueuePCM` returns when a buffer is SCHEDULED, not
  ///    when it has been heard; `playMP3` already returns at the end of its
  ///    clip, so for it this resolves at once.
  ///
  /// A clip whose bytes would not decode still acknowledges: there is nothing
  /// left to play, and staying silent would park the gateway on its 8 s timer.
  private func acknowledgeIfDrained(position: Int, seq: Int, generation: Int) async {
    guard position == playbackEnqueueCount, generation == playbackGeneration else { return }
    await player.awaitDrain()
    guard position == playbackEnqueueCount, generation == playbackGeneration else { return }
    guard state.phase.isEnded == false else { return }
    // A later chunk that carried no playable audio (an empty or undecodable
    // `voice_speech`) never reached the chain, but the gateway still counts
    // its `seq` — and it has, trivially, finished playing.
    let acknowledged = max(seq, state.lastSpeechSeq)
    guard acknowledged >= 0 else { return }
    // Never fatal: a drain ack the socket cannot carry costs the gateway its
    // 8 s safety timer, which is exactly what that timer is for.
    try? await transport.voicePlayed(id: id, seq: acknowledged)
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
      // NOT `playMP3`: that is read aloud's path, and its contract is a
      // `.playback` session this mode cannot adopt without evicting the live
      // microphone — under voice mode's own session it produced no audible
      // output at all on a device. `enqueueCompressed` decodes the chunk and
      // sends it down the same engine the PCM path uses, so which format the
      // configured model returns stops mattering.
      await player.enqueueCompressed(data)
    } else {
      await player.enqueuePCM(data, sampleRate: sampleRate ?? VoiceModeFeature.defaultSampleRate)
    }
  }

  /// Synchronous, and the new HEAD of the playback chain.
  ///
  /// Both halves matter. Bumping the generation the moment the reducer asks
  /// for a flush is what makes already-queued chunks stale before the next
  /// utterance's chunks are appended. Making the player's own `flush()`/
  /// `stop()` the head of the chain — rather than an `await` on the effect
  /// chain — is what keeps them ORDERED against those chunks: a flush that
  /// travelled with the transport sends could run after the next reply had
  /// already been buffered, and drop it.
  ///
  /// The previous chain is cancelled but deliberately NOT awaited: it may be
  /// parked inside `playMP3`, and `player.stop()` below is the thing that
  /// releases it. Awaiting it first would deadlock.
  private func flushPlayback() {
    playbackGeneration &+= 1
    playbackChain?.cancel()
    playbackChain = Task { [weak self] in
      guard let self else { return }
      await self.player.flush()
      await self.player.stop()
    }
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
    flushPlayback()
    await playbackChain?.value
    if isCapturing {
      isCapturing = false
      await capture.stop()
    }
    // UNCONDITIONALLY, and not behind an "is it active?" flag.
    // `AudioCaptureService` activates `.playAndRecord` itself, as the FIRST
    // thing `start()` does, and nothing else will take it down. A flag set
    // only once `start()` returned left the route armed for every ending that
    // landed mid-start — a close tap, a `voice_stopped`, a lost socket, the
    // app going to the background — and for the failure path where the tap
    // throws after the session was activated. `setActive(false)` on a session
    // that was never active is a no-op, so the cost of being wrong the other
    // way is nothing.
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
