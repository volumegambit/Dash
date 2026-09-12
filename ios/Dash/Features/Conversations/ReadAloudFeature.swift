import Foundation
import Observation

/// The one call read aloud makes to the gateway, behind a protocol so the
/// feature can be tested without a network — and so Phase B's voice session
/// can reuse the same seam (`SpeechTranscribing`'s twin).
protocol SpeechSynthesizing: Sendable {
  func synthesize(text: String) async throws -> Data
}

extension GatewayAPI: SpeechSynthesizing {}

/// "Read aloud" on an assistant message (`docs/plans/2026-09-10-speech-design.md`
/// §4). Owns the gateway call, the player and the process-wide audio session
/// for exactly one message at a time.
///
/// Three rules shape it:
///
/// 1. **One voice.** Reading a second message stops the first; toggling the
///    message that is speaking stops it. `speakingMessageID` is therefore the
///    whole selection model, set the instant a read starts (while the audio
///    is still being synthesized) so the row can offer "Stop reading" before
///    a single byte has arrived.
/// 2. **`toggle` does not wait for playback.** Synthesis and playback run in
///    one stored task; `toggle` returns as soon as the state is written. A
///    `generation` counter — bumped by every start and every stop — is what
///    decides whether a completing read still owns the state, so the first
///    read's `playMP3` returning (because the second read stopped it) cannot
///    clear the second read's `speakingMessageID`.
/// 3. **The audio session is deactivated whenever playback ends.** Natural
///    end, stop, interruption, decode failure, shutdown — otherwise whatever
///    was playing before stays ducked with nothing owning the route.
@MainActor
@Observable
final class ReadAloudFeature {
  /// The gateway's TTS ceiling (`MAX_TTS_CHARS` in `speech-routes.ts`), above
  /// which the route 413s. Counted in UTF-16 units, because that is what
  /// JavaScript's `String.length` counts.
  static let maxCharacters = 4_000
  static let failureMessage = "Couldn't read this message aloud. Try again."
  static let unavailableMessage = "Speech isn't set up on your gateway yet."
  static let unauthorizedMessage = "Your gateway's speech provider key was rejected."

  /// The message currently being read — from the moment `toggle` starts,
  /// through synthesis, until playback ends for any reason.
  private(set) var speakingMessageID: String?
  /// True while `speakingMessageID`'s audio is still being synthesized.
  private(set) var isLoading = false
  private(set) var error: String?

  /// Mirrors `error` to the owner — `ChatFeature`, which renders it in the
  /// conversation's existing error banner rather than inventing a second
  /// error surface on the message row. Fires with `nil` when the message is
  /// cleared, so a stale banner cannot outlive it.
  @ObservationIgnored var onErrorChanged: (@MainActor @Sendable (String?) -> Void)?

  @ObservationIgnored private let synthesizer: any SpeechSynthesizing
  @ObservationIgnored private let player: any AudioPlaying
  @ObservationIgnored private let session: any SpeechSessionControlling
  @ObservationIgnored private let interruptions: SpeechInterruptionSource
  @ObservationIgnored private let onRetire: @Sendable () async -> Void
  @ObservationIgnored private var readTask: Task<Void, Never>?
  @ObservationIgnored private var interruptionTask: Task<Void, Never>?
  @ObservationIgnored private var generation: UInt64 = 0
  @ObservationIgnored private var isSessionActive = false

  init(
    synthesizer: any SpeechSynthesizing,
    player: any AudioPlaying,
    session: any SpeechSessionControlling = SystemSpeechSessionControl(),
    interruptions: @escaping SpeechInterruptionSource = SpeechInterruptions.began,
    /// Releases whatever the factory built for this feature alone — in the
    /// app, the `GatewayAPI` (and its `URLSession`) the synthesizer runs on.
    /// Called by `shutdown()`, mirroring `DictationFeature`.
    onRetire: @escaping @Sendable () async -> Void = {}
  ) {
    self.synthesizer = synthesizer
    self.player = player
    self.session = session
    self.interruptions = interruptions
    self.onRetire = onRetire
  }

  // MARK: - Presentation

  /// Whether this message is the one being read (loading or playing) — the
  /// row's "Read aloud" / "Stop reading" switch.
  func isActive(messageID: String) -> Bool {
    speakingMessageID == messageID
  }

  func isLoading(messageID: String) -> Bool {
    isLoading && speakingMessageID == messageID
  }

  // MARK: - Commands

  /// Starts reading `messageID`, or stops it if it is the one already being
  /// read. `text` is the RAW markdown of the assistant's reply — flattening
  /// and truncation happen here, so every caller gets the same spoken text.
  func toggle(messageID: String, text: String) async {
    let wasSpeaking = speakingMessageID == messageID
    await stop()
    guard wasSpeaking == false else { return }

    let spoken = Self.spokenText(for: text)
    // A reply that flattens to nothing (a lone horizontal rule, whitespace)
    // has nothing to say and would only earn a 400 from the route.
    guard spoken.isEmpty == false else { return }

    setError(nil)
    generation &+= 1
    let generation = self.generation
    speakingMessageID = messageID
    isLoading = true
    readTask = Task { [weak self] in
      await self?.read(spoken, generation: generation)
    }
  }

  /// Ends any read in flight. Idempotent, and a no-op when nothing is being
  /// read — so `toggle`'s opening `stop()` cannot invent a spurious
  /// `player.stop()` on an idle player.
  func stop() async {
    guard speakingMessageID != nil else { return }
    // Bumped BEFORE the awaits below: the read task's completion path checks
    // it, so the state it would have written is already stale.
    generation &+= 1
    let retiring = readTask
    readTask = nil
    retiring?.cancel()
    stopObservingInterruptions()
    speakingMessageID = nil
    isLoading = false
    await player.stop()
    deactivateSession()
  }

  /// Ends any read and releases the feature's own resources. Terminal: the
  /// owner has dropped this feature and will build a new one if speech comes
  /// back.
  func shutdown() async {
    await stop()
    await onRetire()
  }

  // MARK: - Text

  /// What actually goes to the gateway: the same flattened plain text the
  /// row's Copy/Share and drag payload use, capped at the route's limit.
  static func spokenText(for text: String) -> String {
    let plain = markdownPlainTextAccessibilityLabel(for: text)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return truncated(plain)
  }

  /// Caps `text` at `maxCharacters` UTF-16 units INCLUDING the trailing "…",
  /// so the request can never be the one that 413s. UTF-16 rather than
  /// `String.count` because the route counts JavaScript `text.length`: 2 001
  /// emoji are 2 001 Characters but 4 002 of the units the gateway measures.
  static func truncated(_ text: String) -> String {
    guard text.utf16.count > maxCharacters else { return text }
    // One unit reserved for the ellipsis.
    let budget = maxCharacters - 1
    var result = ""
    var used = 0
    for character in text {
      let width = String(character).utf16.count
      if used + width > budget { break }
      result.append(character)
      used += width
    }
    return result + "…"
  }

  /// A speech failure the user can act on, rather than the provider's code.
  /// Same shape as `DictationFeature.message(for:)` — only the fallback
  /// sentence differs, because "try again" means something different when the
  /// audio the user recorded is already gone.
  static func message(for error: Error) -> String {
    guard
      let gatewayError = error as? GatewayError,
      case .speech(let code, let message, _) = gatewayError
    else {
      return failureMessage
    }
    switch code {
    case "unavailable":
      return unavailableMessage
    case "unauthorized":
      return unauthorizedMessage
    default:
      // The gateway's own sentence: it is the only party that knows what the
      // provider actually said.
      return message.isEmpty ? failureMessage : message
    }
  }

  // MARK: - Internals

  private func read(_ text: String, generation: UInt64) async {
    do {
      let audio = try await synthesizer.synthesize(text: text)
      guard isCurrent(generation) else { return }
      isLoading = false

      try session.activatePlayback()
      isSessionActive = true
      observeInterruptions(generation: generation)

      try await player.playMP3(audio)
      guard isCurrent(generation) else { return }
      finishPlayback()
    } catch {
      guard isCurrent(generation) else { return }
      stopObservingInterruptions()
      deactivateSession()
      speakingMessageID = nil
      isLoading = false
      setError(Self.message(for: error))
    }
  }

  private func finishPlayback() {
    stopObservingInterruptions()
    deactivateSession()
    speakingMessageID = nil
    isLoading = false
  }

  /// Whether the read that is reporting back is still the one this feature is
  /// showing. A superseded read must write nothing at all — not a state
  /// clear over the read that replaced it, and not a failure banner for audio
  /// nobody is waiting on.
  private func isCurrent(_ generation: UInt64) -> Bool {
    self.generation == generation
  }

  private func setError(_ message: String?) {
    guard error != message else { return }
    error = message
    onErrorChanged?(message)
  }

  private func deactivateSession() {
    guard isSessionActive else { return }
    isSessionActive = false
    session.deactivate()
  }

  private func observeInterruptions(generation: UInt64) {
    let events = interruptions()
    interruptionTask = Task { [weak self] in
      for await _ in events {
        guard let self, Task.isCancelled == false else { return }
        await self.handleInterruption(generation: generation)
        return
      }
    }
  }

  private func stopObservingInterruptions() {
    interruptionTask?.cancel()
    interruptionTask = nil
  }

  /// A phone call, Siri, another app taking the route. `.began` only: read
  /// aloud never auto-resumes on `.ended`, because by then the user is
  /// somewhere else and audio starting again unbidden is worse than silence.
  private func handleInterruption(generation: UInt64) async {
    guard isCurrent(generation) else { return }
    await stop()
  }
}
