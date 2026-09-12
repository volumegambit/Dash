import Foundation
import Observation

/// The gateway's speech-configuration half, behind a protocol so Settings ›
/// Speech can be driven without a network — the twin of `SpeechTranscribing`
/// (A8) and `SpeechSynthesizing` (A9), which stay separate because they are
/// what dictation and read aloud need and nothing more.
protocol SpeechConfiguring: Sendable {
  func speechConfig() async throws -> SpeechConfigResponseDTO
  func patchSpeechConfig(_ patch: SpeechConfigPatchDTO) async throws -> SpeechConfigResponseDTO
  func speechModels(kind: SpeechModelKind) async throws -> [SpeechModelDTO]
}

extension GatewayAPI: SpeechConfiguring {}

/// Settings › Speech (`docs/plans/2026-09-10-speech-design.md` §4): what the
/// gateway is configured to hear and speak with, and the one preview that
/// proves it.
///
/// Three rules shape it:
///
/// 1. **One key per setter.** Every control patches ONLY its own key and
///    replaces `config` from the response, because `PATCH /speech/config` is a
///    shallow per-section merge and a full-section write would silently
///    re-send — and so potentially resurrect — whatever this screen last read.
///    That also makes each setter's request readable in one line.
/// 2. **A failed patch leaves nothing changed on screen.** The optimistic
///    write exists so a `Picker` does not visibly bounce back to the old value
///    while the request is in flight; a failure puts the previous config back
///    and says why.
/// 3. **The audio session belongs to playback alone.** `previewVoice()`
///    activates it only once there are bytes to play and releases it on every
///    exit — the same invariant A9 holds, for the same reason: a synthesis
///    that never plays must not duck the user's music.
@MainActor
@Observable
final class SpeechSettingsFeature {
  /// What "Preview voice" says. Fixed, and deliberately short: it is a voice
  /// sample, not a demo, and every character is billed by the provider.
  static let previewSentence = "Hi, I'm your Dash agent."
  /// The fallback for anything that is not a `GatewayError.speech` — this
  /// screen only ever talks to the gateway, so a non-speech failure IS a
  /// gateway-reachability failure.
  static let failureMessage = "Couldn't reach your gateway. Try again."
  static let unavailableMessage = "Speech isn't set up on your gateway yet."
  static let unauthorizedMessage = "Your gateway's speech provider key was rejected."
  /// The realtime pseudo-provider's reason (`REALTIME_PSEUDO_STATUS` in
  /// `packages/speech/src/service.ts`), as a sentence.
  static let realtimeUnavailableMessage = "No configured provider offers realtime speech yet."
  static let noCredentialMessage = "No API key for this provider on your gateway."

  private(set) var config: SpeechConfigDTO?
  private(set) var providers: [SpeechProviderStatusDTO] = []
  private(set) var transcriptionModels: [SpeechModelDTO] = []
  private(set) var speechModels: [SpeechModelDTO] = []
  private(set) var isLoading = false
  private(set) var isSaving = false
  /// True from the moment "Preview voice" is tapped until playback ends for
  /// any reason — synthesis included, so the button can show progress before
  /// a single byte has arrived.
  private(set) var isPreviewing = false
  var error: String?

  @ObservationIgnored private let api: any SpeechConfiguring
  @ObservationIgnored private let synthesizer: any SpeechSynthesizing
  @ObservationIgnored private let player: any AudioPlaying
  @ObservationIgnored private let session: any SpeechSessionControlling
  @ObservationIgnored private let onRetire: @Sendable () async -> Void
  @ObservationIgnored private var isSessionActive = false
  @ObservationIgnored private var isRetired = false

  init(
    api: any SpeechConfiguring,
    synthesizer: any SpeechSynthesizing,
    player: any AudioPlaying,
    session: any SpeechSessionControlling = SystemSpeechSessionControl(),
    /// Releases whatever the factory built for this screen alone — in the
    /// app, the `GatewayAPI` (and its `URLSession`) every call here runs on.
    /// Mirrors `DictationFeature`/`ReadAloudFeature`.
    onRetire: @escaping @Sendable () async -> Void = {}
  ) {
    self.api = api
    self.synthesizer = synthesizer
    self.player = player
    self.session = session
    self.onRetire = onRetire
  }

  // MARK: - Presentation

  /// The provider that transcribes, as the gateway currently reports it.
  var transcriptionProvider: SpeechProviderStatusDTO? {
    provider(id: config?.stt.provider)
  }

  var speechProvider: SpeechProviderStatusDTO? {
    provider(id: config?.tts.provider)
  }

  /// The realtime pseudo-provider. Found by CAPABILITY rather than by id:
  /// `config.realtime.provider` is nil precisely when there is nothing to
  /// look up, which is the state this row exists to explain.
  var realtimeProvider: SpeechProviderStatusDTO? {
    providers.first { $0.capabilities.realtime }
  }

  var transcriptionAvailability: String {
    Self.availability(of: transcriptionProvider)
  }

  var speechAvailability: String {
    Self.availability(of: speechProvider)
  }

  var realtimeAvailability: String {
    guard let realtimeProvider, realtimeProvider.reason != nil else {
      return Self.realtimeUnavailableMessage
    }
    return Self.availability(of: realtimeProvider)
  }

  /// The voices to choose between, or empty when the selected model publishes
  /// none (then the view offers a free-text field — the app cannot invent a
  /// catalogue the provider did not publish).
  ///
  /// The configured voice is prepended when the model does not list it, so a
  /// `Picker` whose selection is not among its tags — which renders blank —
  /// is impossible. Same shape as `ChatModelPickerSheet`'s "Current model"
  /// section.
  var voiceOptions: [String] {
    guard
      let config,
      let model = speechModels.first(where: { $0.id == config.tts.model }),
      let voices = model.voices,
      voices.isEmpty == false
    else { return [] }
    guard voices.contains(config.tts.voice) else { return [config.tts.voice] + voices }
    return voices
  }

  /// Whether the configured voice is one the selected speech model actually
  /// offers. False after a model change that leaves the previous model's
  /// voice behind — the request would then fail at the provider, so the row
  /// says so rather than showing a value that looks configured.
  ///
  /// True when the model publishes no voices at all: a free-text voice id
  /// cannot be contradicted by a list that does not exist.
  var isVoiceOfferedBySelectedModel: Bool {
    guard
      let config,
      let model = speechModels.first(where: { $0.id == config.tts.model }),
      let voices = model.voices,
      voices.isEmpty == false
    else { return true }
    return voices.contains(config.tts.voice)
  }

  static let voiceNotOfferedMessage = "Not offered by this model"

  /// Language-only locale identifiers ("en", "fr", "zh"), sorted by the name
  /// the user reads. Computed once: `Locale.availableIdentifiers` is ~1 000
  /// entries and this is read on every body evaluation of the picker.
  static let languageCodes: [String] = {
    let codes = Set(
      Locale.availableIdentifiers.filter { identifier in
        identifier.contains("_") == false
          && identifier.contains("-") == false
          && (2...3).contains(identifier.count)
          && identifier.allSatisfy(\.isLetter)
      }
    )
    return codes.sorted {
      languageLabel(for: $0).localizedCaseInsensitiveCompare(languageLabel(for: $1))
        == .orderedAscending
    }
  }()

  static func languageLabel(for code: String) -> String {
    Locale.current.localizedString(forLanguageCode: code) ?? code
  }

  // MARK: - Commands

  func load() async {
    // Never over a patch in flight: the gateway has not written yet, so the
    // answer would be the PRE-patch config, and adopting it would put the old
    // value back on screen and clear an error the user has not read.
    guard isLoading == false, isSaving == false else { return }
    isLoading = true
    error = nil
    defer { isLoading = false }
    do {
      // Concurrently: three independent reads, and the screen is useless
      // until it has all three.
      async let configuration = api.speechConfig()
      async let transcription = api.speechModels(kind: .transcription)
      async let speech = api.speechModels(kind: .speech)
      let response = try await configuration
      config = response.config
      providers = response.providers
      transcriptionModels = try await transcription
      speechModels = try await speech
    } catch {
      self.error = Self.message(for: error)
    }
  }

  func setSTTModel(_ id: String) async {
    guard let config, config.stt.model != id else { return }
    await patch(
      SpeechConfigPatchDTO(stt: SpeechSttPatchDTO(model: id)),
      optimistic: config.replacing(stt: config.stt.replacing(model: id))
    )
  }

  func setTTSModel(_ id: String) async {
    guard let config, config.tts.model != id else { return }
    await patch(
      SpeechConfigPatchDTO(tts: SpeechTtsPatchDTO(model: id)),
      optimistic: config.replacing(tts: config.tts.replacing(model: id))
    )
  }

  func setVoice(_ voice: String) async {
    let trimmed = voice.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let config, trimmed.isEmpty == false, config.tts.voice != trimmed else { return }
    await patch(
      SpeechConfigPatchDTO(tts: SpeechTtsPatchDTO(voice: trimmed)),
      optimistic: config.replacing(tts: config.tts.replacing(voice: trimmed))
    )
  }

  /// `nil` is "Auto", and it is sent as an explicit JSON `null` — the
  /// gateway's `validateSttPatch` reads an omitted `language` as "leave it
  /// alone" and a null as "clear it", and `stt.language` is absent when the
  /// provider auto-detects. An encoder that dropped the key would send a
  /// no-op patch whose response snaps the picker back.
  func setLanguage(_ code: String?) async {
    guard let config, config.stt.language != code else { return }
    guard code?.isEmpty != true else { return }
    await patch(
      SpeechConfigPatchDTO(stt: SpeechSttPatchDTO(language: NullableString(code))),
      optimistic: config.replacing(stt: config.stt.replacing(language: code))
    )
  }

  /// Speaks `previewSentence` in the configured voice. Awaits playback, so a
  /// caller's spinner lives exactly as long as the sound does.
  func previewVoice() async {
    guard isPreviewing == false, isRetired == false else { return }
    isPreviewing = true
    error = nil
    defer { isPreviewing = false }
    do {
      let audio = try await synthesizer.synthesize(text: Self.previewSentence)
      // Retired mid-synthesis: the owner has dropped this screen, and
      // arming the audio route now would duck the user's music for a sound
      // nobody asked to keep hearing.
      guard isRetired == false else { return }
      try session.activatePlayback()
      isSessionActive = true
      try await player.playMP3(audio)
      deactivateSession()
    } catch {
      deactivateSession()
      self.error = Self.message(for: error)
    }
  }

  /// Ends any preview and releases the feature's own resources. Terminal: the
  /// owner has dropped this screen and will build a new one if speech comes
  /// back.
  func shutdown() async {
    isRetired = true
    if isPreviewing {
      await player.stop()
    }
    deactivateSession()
    isPreviewing = false
    await onRetire()
  }

  // MARK: - Copy

  /// A speech failure the user can act on, rather than the provider's code.
  /// The same mapping `ReadAloudFeature.message(for:)` uses — only the
  /// fallback sentence differs, because on this screen the thing that failed
  /// is the gateway conversation itself, not one message's audio.
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

  static func availability(of provider: SpeechProviderStatusDTO?) -> String {
    guard let provider else { return "Not configured on your gateway." }
    guard provider.available == false else { return "Ready" }
    switch provider.reason {
    case .noCredential:
      return noCredentialMessage
    case .noProviderOffersRealtime:
      return realtimeUnavailableMessage
    case nil:
      return "Unavailable on your gateway."
    }
  }

  // MARK: - Internals

  private func provider(id: String?) -> SpeechProviderStatusDTO? {
    guard let id else { return nil }
    return providers.first { $0.id == id }
  }

  /// Sends one key and adopts the merged configuration the gateway answers
  /// with. Serialized on `isSaving`: two patches in flight would race, and
  /// the loser's response would clobber the winner's value on screen.
  private func patch(_ patch: SpeechConfigPatchDTO, optimistic: SpeechConfigDTO) async {
    guard isSaving == false else { return }
    let previous = config
    isSaving = true
    error = nil
    config = optimistic
    defer { isSaving = false }
    do {
      let response = try await api.patchSpeechConfig(patch)
      config = response.config
      providers = response.providers
    } catch {
      config = previous
      self.error = Self.message(for: error)
    }
  }

  private func deactivateSession() {
    guard isSessionActive else { return }
    isSessionActive = false
    session.deactivate()
  }
}

// MARK: - One-field copies
//
// The DTOs are immutable value types written against the contract document,
// so an optimistic write builds a new one. Kept here rather than on the DTOs
// themselves: they are wire types, and only this screen edits them field by
// field.

extension SpeechConfigDTO {
  func replacing(stt: SpeechSttConfigDTO) -> SpeechConfigDTO {
    SpeechConfigDTO(stt: stt, tts: tts, realtime: realtime)
  }

  func replacing(tts: SpeechTtsConfigDTO) -> SpeechConfigDTO {
    SpeechConfigDTO(stt: stt, tts: tts, realtime: realtime)
  }
}

extension SpeechSttConfigDTO {
  func replacing(model: String) -> SpeechSttConfigDTO {
    SpeechSttConfigDTO(provider: provider, model: model, language: language)
  }

  /// `nil` is a real value here — the configuration a cleared language leaves
  /// behind — so this cannot take a non-optional the way `replacing(model:)`
  /// does.
  func replacing(language: String?) -> SpeechSttConfigDTO {
    SpeechSttConfigDTO(provider: provider, model: model, language: language)
  }
}

extension SpeechTtsConfigDTO {
  func replacing(model: String) -> SpeechTtsConfigDTO {
    SpeechTtsConfigDTO(provider: provider, model: model, voice: voice, speed: speed)
  }

  func replacing(voice: String) -> SpeechTtsConfigDTO {
    SpeechTtsConfigDTO(provider: provider, model: model, voice: voice, speed: speed)
  }
}
