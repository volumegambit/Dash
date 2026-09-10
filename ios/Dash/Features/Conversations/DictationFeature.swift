@preconcurrency import AVFoundation
import Foundation
import Observation

/// The one call dictation makes to the gateway, behind a protocol so the
/// feature can be tested without a network — and so Phase B's voice session
/// can reuse the same seam.
protocol SpeechTranscribing: Sendable {
  func transcribe(_ request: TranscriptionRequestDTO) async throws -> TranscriptionResponseDTO
}

extension GatewayAPI: SpeechTranscribing {}

/// `SpeechAudioSession` behind a protocol for the same reason: it writes to
/// the PROCESS-WIDE `AVAudioSession`, and a unit test that armed the mic
/// route would affect every other test in the same process.
protocol SpeechSessionControlling: Sendable {
  func activateRecording() throws
  func deactivate()
}

struct SystemSpeechSessionControl: SpeechSessionControlling {
  func activateRecording() throws {
    try SpeechAudioSession.activateRecording()
  }

  func deactivate() {
    SpeechAudioSession.deactivate()
  }
}

/// Yields once per interruption that STARTS (a phone call, Siri, another app
/// taking the input route). A factory rather than a stream, because — like
/// `AudioRecording.level` — a consumer whose task is cancelled kills the
/// stream it was reading, so each recording takes a fresh one.
typealias SpeechInterruptionSource = @Sendable () -> AsyncStream<Void>

enum SpeechInterruptions {
  /// The system source. `.began` only: `.ended` arrives with an "resume"
  /// option the recorder cannot honour — the clip is already discarded — so
  /// dictation treats an interruption as terminal.
  static let began: SpeechInterruptionSource = {
    AsyncStream { continuation in
      // `nonisolated(unsafe)`: the observer token is not `Sendable`, and
      // `onTermination` must capture it to unregister. Both the registration
      // and the removal happen on the main queue, so the token is never
      // touched concurrently.
      nonisolated(unsafe) let observer = NotificationCenter.default.addObserver(
        forName: AVAudioSession.interruptionNotification,
        object: nil,
        queue: .main
      ) { notification in
        let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        guard raw == AVAudioSession.InterruptionType.began.rawValue else { return }
        continuation.yield(())
      }
      continuation.onTermination = { _ in
        NotificationCenter.default.removeObserver(observer)
      }
    }
  }
}

/// Dictation in the composer (`docs/plans/2026-09-10-speech-design.md` §4).
///
/// Owns the recorder, the microphone permission and the upload; the state
/// machine itself lives in `DictationReducer` (Task A7), which is pure and
/// tested separately. What this adds is the part a reducer cannot express:
/// which tasks are running, which of them must be cancelled when, and when
/// the process-wide audio session is active.
///
/// Three rules earned the shape below:
///
/// 1. **One fresh meter stream per recording.** `AudioRecording.level` hands
///    back an independent stream on every access and ends it when the
///    recording does. Taking one at init and reusing it would leave the app
///    permanently unmetered after the first cancelled task.
/// 2. **The upload is a stored task.** The reducer's `.transcribed` guard is
///    phase-only, so it cannot tell upload #1's late reply from upload #2's;
///    starting or cancelling a recording therefore cancels the in-flight
///    transcription explicitly.
/// 3. **The audio session is deactivated on every exit.** Finish, cancel,
///    interruption and every failure path — otherwise the mic route stays
///    armed and whatever was playing before stays ducked.
@MainActor
@Observable
final class DictationFeature {
  static let permissionDeniedMessage = "Microphone access is off. Turn it on in Settings."
  static let interruptedMessage = "Recording was interrupted."
  static let emptyTranscriptMessage = "Nothing was heard."
  static let couldNotStartMessage = "Dash couldn't start recording."
  static let couldNotFinishMessage = "Dash couldn't finish the recording."
  static let transcriptionFailedMessage = "Transcription failed. Try again."

  private(set) var state = DictationState()

  /// Where a finished transcript goes — `ChatFeature.insertDictation(_:)` in
  /// the app. Set by the owner rather than injected, so the factory that
  /// builds this feature stays ignorant of the conversation it serves.
  @ObservationIgnored var onInsert: (@MainActor @Sendable (String) async -> Void)?

  @ObservationIgnored private let recorder: any AudioRecording
  @ObservationIgnored private let permission: any SpeechPermissionRequesting
  @ObservationIgnored private let transcriber: any SpeechTranscribing
  @ObservationIgnored private let clock: any AppClock
  @ObservationIgnored private let session: any SpeechSessionControlling
  @ObservationIgnored private let interruptions: SpeechInterruptionSource
  @ObservationIgnored private var meterTask: Task<Void, Never>?
  @ObservationIgnored private var interruptionTask: Task<Void, Never>?
  @ObservationIgnored private var transcriptionTask: Task<TranscriptionResponseDTO, Error>?
  @ObservationIgnored private var startedAt: Date?
  @ObservationIgnored private var isRecorderRunning = false
  @ObservationIgnored private var isSessionActive = false

  init(
    recorder: any AudioRecording,
    permission: any SpeechPermissionRequesting,
    transcriber: any SpeechTranscribing,
    clock: any AppClock = SystemAppClock(),
    session: any SpeechSessionControlling = SystemSpeechSessionControl(),
    interruptions: @escaping SpeechInterruptionSource = SpeechInterruptions.began
  ) {
    self.recorder = recorder
    self.permission = permission
    self.transcriber = transcriber
    self.clock = clock
    self.session = session
    self.interruptions = interruptions
  }

  // MARK: - Presentation

  /// Whether the composer's text field is currently replaced by dictation.
  var isBusy: Bool {
    switch state.phase {
    case .recording, .uploading: true
    case .idle, .failed: false
    }
  }

  var isRecording: Bool {
    if case .recording = state.phase { return true }
    return false
  }

  var isUploading: Bool {
    state.phase == .uploading
  }

  var failureMessage: String? {
    if case .failed(let message) = state.phase { return message }
    return nil
  }

  /// A denied microphone can only be fixed in Settings — iOS never prompts
  /// twice — so that one failure carries a button instead of a retry.
  var showsSettingsAction: Bool {
    failureMessage == Self.permissionDeniedMessage
  }

  var meterFraction: Double {
    guard case .recording(_, let level) = state.phase else { return 0 }
    return Self.meterFraction(for: level)
  }

  var countdown: String {
    Self.countdownText(remaining: remaining)
  }

  private var remaining: Duration {
    guard case .recording(let elapsed, _) = state.phase else {
      return DictationState.maxDuration
    }
    return DictationState.maxDuration - elapsed
  }

  /// `AudioRecorderService` reports LINEAR amplitude, where ordinary speech
  /// sits around 0.1 and a shout barely reaches 0.3 — a bar drawn straight
  /// from it looks broken. ×4, clamped, puts conversational speech in the
  /// middle of the bar and keeps silence at zero.
  static func meterFraction(for level: Float) -> Double {
    Double(min(1, max(0, level * 4)))
  }

  /// `mm:ss`, floored, never negative.
  static func countdownText(remaining: Duration) -> String {
    let seconds = max(0, Int(remaining.components.seconds))
    return String(format: "%d:%02d", seconds / 60, seconds % 60)
  }

  /// A speech failure the user can act on, rather than the provider's code.
  ///
  /// `GatewayError` has no `LocalizedError` conformance, so
  /// `error.localizedDescription` renders "The operation couldn't be
  /// completed. (Dash.GatewayError error 2.)" — which is why anything that is
  /// not a `/speech` failure gets a plain sentence instead.
  static func message(for error: Error) -> String {
    guard
      let gatewayError = error as? GatewayError,
      case .speech(let code, let message, _) = gatewayError
    else {
      return transcriptionFailedMessage
    }
    switch code {
    case "unavailable":
      return "Speech isn't set up on your gateway yet."
    case "unauthorized":
      return "Your gateway's speech provider key was rejected."
    default:
      // The gateway's own sentence: it is the only party that knows what the
      // provider actually said.
      return message.isEmpty ? transcriptionFailedMessage : message
    }
  }

  // MARK: - Commands

  func start() async {
    // Rule 2: whatever upload was in flight belongs to audio the user has
    // moved on from.
    cancelTranscription()
    guard await permission.requestMicrophone() else {
      apply(.failed(Self.permissionDeniedMessage))
      return
    }
    // `AudioRecording.start` throws `alreadyRecording` over a live recording,
    // so a retry has to discard the previous one first.
    stopObserving()
    await discardRecording()

    do {
      try session.activateRecording()
      isSessionActive = true
    } catch {
      deactivateSession()
      apply(.failed(Self.couldNotStartMessage))
      return
    }

    do {
      try await recorder.start(maxDuration: DictationState.maxDuration)
    } catch {
      deactivateSession()
      apply(.failed(Self.couldNotStartMessage))
      return
    }

    isRecorderRunning = true
    startedAt = await clock.now()
    apply(.started)
    observeMeter()
    observeInterruptions()
  }

  /// The user tapped the check. Returns the inserted transcript, or nil when
  /// nothing was inserted (an empty clip, a failure, or an upload the user
  /// cancelled by recording again).
  @discardableResult
  func finish() async -> String? {
    guard isRecording else { return nil }
    return await performFinish()
  }

  func cancel() async {
    cancelTranscription()
    stopObserving()
    await discardRecording()
    deactivateSession()
    apply(.cancelled)
  }

  /// Dismisses a failure message. Only `.failed` responds — see the reducer.
  func acknowledgeFailure() {
    apply(.reset)
  }

  // MARK: - Internals

  @discardableResult
  private func apply(_ action: DictationAction) -> DictationEffect? {
    DictationReducer.reduce(state: &state, action: action)
  }

  private func performFinish() async -> String? {
    apply(.finished)
    guard state.phase == .uploading else { return nil }
    // Cancelling the meter task from inside it (the auto-finish path runs
    // here) is safe: nothing below is cancellation-aware, and the upload is
    // an unstructured `Task`, which does not inherit cancellation.
    stopObserving()

    let audio: Data
    do {
      audio = try await recorder.stop()
      isRecorderRunning = false
    } catch {
      isRecorderRunning = false
      deactivateSession()
      apply(.failed(Self.couldNotFinishMessage))
      return nil
    }
    deactivateSession()

    // Base64 of the clip. Never logged, never persisted: the usage string
    // promises the recording leaves as text and nothing else.
    let request = TranscriptionRequestDTO(audio: audio.base64EncodedString(), format: .m4a)
    let transcriber = self.transcriber
    let task = Task { try await transcriber.transcribe(request) }
    transcriptionTask = task

    do {
      let response = try await task.value
      guard isCurrent(task) else { return nil }
      transcriptionTask = nil
      let text = response.text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard text.isEmpty == false else {
        apply(.failed(Self.emptyTranscriptMessage))
        return nil
      }
      guard case .insert(let inserted)? = apply(.transcribed(text)) else { return nil }
      await onInsert?(inserted)
      return inserted
    } catch {
      guard isCurrent(task) else { return nil }
      transcriptionTask = nil
      apply(.failed(Self.message(for: error)))
      return nil
    }
  }

  /// Whether this upload is still the one the feature is waiting on. A
  /// cancelled or superseded upload must not write anything — not the
  /// transcript, and not a failure banner over a recording already underway.
  private func isCurrent(_ task: Task<TranscriptionResponseDTO, Error>) -> Bool {
    transcriptionTask == task && task.isCancelled == false
  }

  private func cancelTranscription() {
    transcriptionTask?.cancel()
    transcriptionTask = nil
  }

  private func discardRecording() async {
    guard isRecorderRunning else { return }
    isRecorderRunning = false
    await recorder.cancel()
  }

  private func deactivateSession() {
    guard isSessionActive else { return }
    isSessionActive = false
    session.deactivate()
  }

  private func observeMeter() {
    // Rule 1: one fresh stream, taken here, ended by the recorder when this
    // recording ends.
    let levels = recorder.level
    meterTask = Task { [weak self] in
      for await level in levels {
        guard let self, Task.isCancelled == false else { return }
        await self.handleLevel(level)
      }
      guard let self, Task.isCancelled == false else { return }
      await self.handleMeterEnded()
    }
  }

  private func observeInterruptions() {
    let events = interruptions()
    interruptionTask = Task { [weak self] in
      for await _ in events {
        guard let self, Task.isCancelled == false else { return }
        await self.handleInterruption()
        return
      }
    }
  }

  private func stopObserving() {
    meterTask?.cancel()
    meterTask = nil
    interruptionTask?.cancel()
    interruptionTask = nil
  }

  private func handleLevel(_ level: Float) async {
    guard isRecording, let startedAt else { return }
    // Elapsed from the clock rather than a sample count: a dropped or
    // delayed meter sample must not slow the countdown down, and a fake
    // clock makes the 60 s cap testable in milliseconds.
    let elapsed = Duration.seconds(max(0, await clock.now().timeIntervalSince(startedAt)))
    if apply(.tick(elapsed: elapsed, level: level)) == .autoFinish {
      await performFinish()
    }
  }

  /// The meter ended while still recording: the recorder's own `forDuration`
  /// backstop stopped it (the app was suspended, so the tick loop never
  /// reached the cap). The clip is complete — upload it rather than leaving
  /// a frozen bar on screen.
  private func handleMeterEnded() async {
    guard isRecording else { return }
    await performFinish()
  }

  private func handleInterruption() async {
    guard isRecording else { return }
    stopObserving()
    await discardRecording()
    deactivateSession()
    apply(.failed(Self.interruptedMessage))
  }
}
