import Foundation

// The dictation state machine, kept pure and free of AVFoundation so it can be
// tested without a microphone — the simulator has none, and every audio-facing
// piece of this feature (`AudioRecorderService`, `SpeechAudioSession`) is
// therefore only reachable on a device. Everything that decides *what the UI
// shows* and *when the upload starts* lives here instead.
// See `docs/plans/2026-09-10-speech-design.md` §4 iOS (Dictation, Phase A).

struct DictationState: Equatable, Sendable {
  enum Phase: Equatable, Sendable {
    case idle
    /// `level` is the 0…1 meter value from `AudioRecorderService.level`;
    /// `elapsed` drives the `mm:ss` countdown and is clamped to `maxDuration`.
    case recording(elapsed: Duration, level: Float)
    case uploading
    /// The message is shown until the user acknowledges it (`reset`) or starts
    /// a new recording.
    case failed(String)
  }

  var phase: Phase = .idle

  /// The clip cap. OpenRouter's transcription endpoint refuses much longer
  /// requests (the plan's upstream limit: ≤ 60 s, ≤ 8 MB), so the client cuts
  /// the recording itself rather than letting the user talk for two minutes
  /// and then discover the upload is rejected.
  static let maxDuration: Duration = .seconds(60)
}

enum DictationAction: Sendable {
  case started
  case tick(elapsed: Duration, level: Float)
  case finished
  case transcribed(String)
  case failed(String)
  case cancelled
  case reset
}

enum DictationEffect: Equatable, Sendable {
  /// The cap was reached: the owner should stop the recorder and upload, as if
  /// the user had tapped the check.
  case autoFinish
  /// Append the transcript to the composer draft. Nothing is sent to the agent
  /// — the user still taps send.
  case insert(String)
}

enum DictationReducer {
  static func reduce(state: inout DictationState, action: DictationAction) -> DictationEffect? {
    switch action {
    case .started:
      // Also the retry path out of `.failed`: the audio is gone, so a retry is
      // always a fresh recording.
      state.phase = .recording(elapsed: .zero, level: 0)
      return nil

    case let .tick(elapsed, level):
      // A meter sample buffered before a cancel can arrive after it. Ignoring
      // ticks outside `.recording` keeps that late sample from resurrecting a
      // recording the user already dismissed.
      guard case let .recording(previousElapsed, _) = state.phase else { return nil }
      let clamped = min(elapsed, DictationState.maxDuration)
      state.phase = .recording(elapsed: clamped, level: level)
      // `autoFinish` must fire exactly once. Rather than latch a flag, we read
      // the crossing off the state we already keep: the previous elapsed is
      // clamped too, so every tick after the first one at the cap compares
      // 60 s < 60 s and returns nil. A cancel or a new `started` resets the
      // elapsed, so the next recording can auto-finish again.
      let crossedTheCap =
        previousElapsed < DictationState.maxDuration && clamped >= DictationState.maxDuration
      return crossedTheCap ? .autoFinish : nil

    case .finished:
      // The user's tap and the cap's `autoFinish` race by design; whichever
      // arrives second finds `.uploading` and is ignored.
      guard case .recording = state.phase else { return nil }
      state.phase = .uploading
      return nil

    case let .transcribed(text):
      // Only an upload we are still waiting on may write to the draft. A
      // transcript that lands after the user cancelled is discarded audio, and
      // inserting it would put words in the composer the user threw away.
      guard case .uploading = state.phase else { return nil }
      state.phase = .idle
      return .insert(text)

    case let .failed(message):
      // Accepted from every phase, `.idle` included: a denied microphone
      // permission fails before any recording starts.
      state.phase = .failed(message)
      return nil

    case .cancelled:
      state.phase = .idle
      return nil

    case .reset:
      // Acknowledging a failure only. A `reset` that dropped `.recording` to
      // `.idle` would leave the recorder running with nothing owning it —
      // cancelling is the action for that.
      guard case .failed = state.phase else { return nil }
      state.phase = .idle
      return nil
    }
  }
}
