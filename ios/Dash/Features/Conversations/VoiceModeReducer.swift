import Foundation

// The hands-free voice session's state machine (speech Phase B, Task B9).
//
// Pure and free of AVFoundation for the same reason `DictationReducer` is: a
// simulator has no microphone and no audio route, so every audio-facing piece
// of voice mode is only reachable on a device. Everything that decides *what
// the cover shows* and *what is sent to the gateway* lives here instead, and
// `VoiceModeFeature` is left owning only the parts a reducer cannot express —
// which task is running, when the audio session is active, and the order
// effects are performed in.
//
// See `docs/plans/2026-09-10-speech-design.md` §4 iOS (Voice mode, Phase B).

struct VoiceModeState: Equatable, Sendable {
  enum Phase: Equatable, Sendable {
    /// `voice_start` has been sent; no `voice_state` has come back. Audio
    /// captured in this phase is DROPPED rather than sent — the gateway is
    /// still checking provider availability and discards anything that
    /// arrives before its own `voice_state listening` (Task B6).
    case connecting
    case listening
    case transcribing
    case thinking
    case speaking
    case muted
    /// Terminal. `reason` is shown to the user for a moment and then the
    /// cover dismisses itself.
    case ended(reason: String)

    /// The state line under the orb, and its accessibility label.
    ///
    /// `transcribing` deliberately reads "Thinking" rather than a fifth
    /// label: it is the sub-second gap between the user going quiet and the
    /// model starting, and naming it separately makes the line flicker on
    /// every utterance.
    var title: String {
      switch self {
      case .connecting: "Connecting…"
      case .listening: "Listening"
      case .transcribing, .thinking: "Thinking"
      case .speaking: "Speaking"
      case .muted: "Muted"
      case .ended(let reason): reason
      }
    }

    var isEnded: Bool {
      if case .ended = self { return true }
      return false
    }
  }

  var phase: Phase = .connecting
  /// What the gateway has heard so far this utterance — the partial
  /// transcript, replaced (not appended to) by every `voice_transcript`.
  var userCaption: String = ""
  /// What the assistant has said so far this turn, appended chunk by chunk
  /// from `voice_speech` and cleared when the session settles back to
  /// listening.
  var assistantCaption: String = ""
  /// 0…1 RMS microphone level, for the orb.
  var level: Float = 0
  /// The last thing that went wrong, shown under the captions. Not fatal on
  /// its own — a provider hiccup mid-session leaves the session running.
  var error: String?

  /// Whether captured audio may be sent right now.
  ///
  /// Two rules in one: nothing before the gateway's first `voice_state`
  /// (Task B6 — it is dropped anyway), and nothing while muted. Capture keeps
  /// RUNNING while muted so the orb still moves and unmuting is instant; the
  /// frames are simply not transmitted.
  var sendsAudio: Bool {
    switch phase {
    case .listening, .transcribing, .thinking, .speaking: true
    case .connecting, .muted, .ended: false
    }
  }

  static let endedMessage = "Voice mode ended"
  static let connectionLostMessage = "Connection lost"
  static let microphoneStoppedMessage = "Microphone stopped"
  static let providerStoppedMessage = "The voice provider stopped"
  static let replacedMessage = "Voice mode started on another device"
  static let permissionDeniedMessage = "Microphone access is off. Turn it on in Settings."
  static let couldNotStartMessage = "Dash couldn't start voice mode."

  static func message(for reason: VoiceStopReason) -> String {
    switch reason {
    case .client: endedMessage
    case .socket: connectionLostMessage
    case .provider: providerStoppedMessage
    case .replaced: replacedMessage
    case .unknown: endedMessage
    }
  }
}

enum VoiceModeAction: Sendable {
  case started
  case frame(MobileWSServerFrame)
  case micLevel(Float)
  case muteToggled
  /// A tap on the orb. A local interrupt affordance only — barge-in proper is
  /// server-driven (the gateway's VAD hears the user over the assistant and
  /// sends `voice_state listening`), so this silences what this device has
  /// already buffered and nothing more.
  case orbTapped
  case stopRequested
  /// The capture stream finished on its own: a phone call, Siri, or the
  /// active input device disappearing (Task B8 — a finished stream IS the
  /// interruption signal, there is no error to catch).
  case captureInterrupted
  case transportLost
  /// A failure this device found by itself — a denied microphone, a capture
  /// that would not start, a `voice_start` the socket refused. Not in the
  /// task brief's action list; added because resolution 5 requires voice mode
  /// to "end with a clear error if denied" and no frame describes that.
  case failed(String)
}

enum VoiceModeEffect: Equatable, Sendable {
  case sendStart
  case sendMute(Bool)
  case sendStop
  /// `ChatFeature` does exactly what `send()` does for an optimistic row, so
  /// the hub's following `accepted` adopts it and the spoken words appear as
  /// the user's bubble rather than as an empty one.
  case startLocalTurn(turnID: String, text: String)
  case play(Data, sampleRate: Double?, format: String)
  case flushPlayback
  case dismiss
}

enum VoiceModeReducer {
  static func reduce(state: inout VoiceModeState, action: VoiceModeAction) -> [VoiceModeEffect] {
    // `.ended` is terminal. Frames for a session the gateway has already
    // stopped, a level sample buffered before the stop, a mute tap racing the
    // close button — all of them arrive AFTER the decision has been made, and
    // acting on any of them would resurrect a session with no capture behind
    // it. The one action that still means something is the close button.
    if state.phase.isEnded {
      if case .stopRequested = action { return [.dismiss] }
      return []
    }

    switch action {
    case .started:
      state.phase = .connecting
      return [.sendStart]

    case .frame(let frame):
      return reduce(state: &state, frame: frame)

    case .micLevel(let level):
      state.level = level
      return []

    case .muteToggled:
      switch state.phase {
      case .muted:
        // Optimistic: no `voice_state` arrives while muted, so the phase has
        // to come from somewhere — and the gateway re-announces the real
        // state the instant the mute lifts (Task B4), which corrects this.
        state.phase = .listening
        return [.sendMute(false)]
      case .listening, .transcribing, .thinking, .speaking:
        // Deliberately no `flushPlayback`: muting silences the MICROPHONE.
        // Cutting the assistant off mid-sentence because the user muted
        // themselves would lose words they never asked to skip.
        state.phase = .muted
        return [.sendMute(true)]
      case .connecting, .ended:
        // There is no session to mute yet; `voice_mute` before `voice_start`
        // lands earns a `voice_error { invalid }` from the gateway.
        return []
      }

    case .orbTapped:
      guard state.phase == .speaking else { return [] }
      // The previous utterance's caption is what is on screen; clearing it is
      // the visible half of "I'm taking over now".
      state.userCaption = ""
      return [.flushPlayback]

    case .stopRequested:
      state.phase = .ended(reason: VoiceModeState.endedMessage)
      // No `flushPlayback` here even from `.speaking`: EVERY ending path —
      // this one, `voice_stopped`, a lost transport, an interrupted capture —
      // runs through `VoiceModeFeature.finish`, which stops capture, flushes
      // playback and releases the audio session in one place. Emitting it
      // from some ending actions and not others would only make the reducer
      // table lie about which endings are quiet.
      return [.sendStop, .dismiss]

    case .captureInterrupted:
      state.phase = .ended(reason: VoiceModeState.microphoneStoppedMessage)
      // The one ending that the gateway does not already know about: the
      // socket is fine, so tell it to stop rather than leaving a session
      // listening to a microphone that is gone.
      return [.sendStop]

    case .transportLost:
      state.phase = .ended(reason: VoiceModeState.connectionLostMessage)
      return []

    case .failed(let message):
      state.error = message
      state.phase = .ended(reason: message)
      return []
    }
  }

  private static func reduce(
    state: inout VoiceModeState,
    frame: MobileWSServerFrame
  ) -> [VoiceModeEffect] {
    switch frame {
    case let .voiceState(_, voiceState, _):
      // `stopped` is never sent (Task B4) and an unknown state belongs to a
      // gateway newer than this build; neither may move the UI.
      guard let phase = phase(for: voiceState), phase != state.phase else { return [] }
      let wasSpeaking = state.phase == .speaking
      state.phase = phase
      // Back to listening means the assistant's turn is over — the caption
      // that belonged to it goes with it. Every other exit from `speaking`
      // (thinking, transcribing, a mute) is still the same turn.
      if wasSpeaking, phase == .listening { state.assistantCaption = "" }
      return wasSpeaking ? [.flushPlayback] : []

    case let .voiceTranscript(_, text, _, turnID):
      state.userCaption = text
      // Keyed on `turnId`, NOT on `final` (Task B4): a queued utterance is
      // transcribed once with `final: true` and NO turn id — its turn has not
      // started yet — and then again, with the id, when it does. Starting a
      // row on the first would leave an orphan the `accepted` never adopts.
      guard let turnID, turnID.isEmpty == false, text.isEmpty == false else { return [] }
      return [.startLocalTurn(turnID: turnID, text: text)]

    case let .voiceSpeech(_, _, audio, format, sampleRate, text):
      state.assistantCaption += text
      // A chunk whose bytes will not decode still has words in it; showing
      // them beats a silent gap in the captions.
      guard let data = Data(base64Encoded: audio), data.isEmpty == false else { return [] }
      return [.play(data, sampleRate: sampleRate.map(Double.init), format: format)]

    case let .voiceError(_, _, message):
      state.error = message
      // A `voice_start` the gateway refuses (no provider, unknown
      // conversation) produces this frame and NOTHING else — no
      // `voice_stopped` follows it (`apps/gateway/src/chat-ws.ts`
      // `startVoice`), so an error that arrives before the session is live is
      // the end of it. Mid-session, a provider hiccup is just a message: the
      // session goes back to listening on its own.
      if state.phase == .connecting { state.phase = .ended(reason: message) }
      return []

    case let .voiceStopped(_, reason):
      state.phase = .ended(reason: VoiceModeState.message(for: reason))
      return []

    case .accepted, .event, .done, .error:
      // Chat-turn frames never reach this reducer — `ChatFeature` routes only
      // `voice_*` here — but the switch is exhaustive rather than defaulted
      // so a new frame case has to be considered.
      return []
    }
  }

  private static func phase(for state: VoiceState) -> VoiceModeState.Phase? {
    switch state {
    case .listening: .listening
    case .transcribing: .transcribing
    case .thinking: .thinking
    case .speaking: .speaking
    case .muted: .muted
    case .stopped, .unknown: nil
    }
  }
}
