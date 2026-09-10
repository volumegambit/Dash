import Foundation
import Testing

@testable import Dash

/// Settings › Speech (Task A10). Everything the screen decides — what it asks
/// the gateway for, what a setter sends, what happens when a patch fails, and
/// what the user is told — is decided here, so the view stays a rendering of
/// this state.
///
/// The gateway is a fake for the same reason A9's is: the simulator has no
/// audio route and a unit test has no gateway.
@Suite("Speech settings feature", .serialized)
@MainActor
struct SpeechSettingsFeatureTests {
  // MARK: - Load

  @Test("loading populates the config, the providers and both model lists")
  func loadPopulates() async {
    let harness = Harness()

    await harness.feature.load()

    #expect(harness.feature.config == SpeechFixtures.config)
    #expect(harness.feature.providers.map(\.id) == ["openrouter", "realtime"])
    #expect(
      harness.feature.transcriptionModels.map(\.id)
        == ["openai/whisper-large-v3", "openai/whisper-tiny"]
    )
    #expect(
      harness.feature.speechModels.map(\.id)
        == ["openai/gpt-4o-mini-tts-2025-12-15", "openai/tts-1", "openrouter/plain-tts"]
    )
    #expect(harness.feature.isLoading == false)
    #expect(harness.feature.error == nil)
    // Both kinds, asked for by name: the route has no default and answers a
    // MIXED list to nobody.
    #expect(await harness.api.modelRequests.sorted { $0.rawValue < $1.rawValue }
      == [.speech, .transcription])
  }

  @Test("a gateway with no speech provider says so instead of showing an empty form")
  func loadFailureSurfacesTheGatewaysMeaning() async {
    let harness = Harness()
    await harness.api.setLoadFailure(
      GatewayError.speech(code: "unavailable", message: "speech is not configured", retryable: false)
    )

    await harness.feature.load()

    #expect(harness.feature.config == nil)
    #expect(harness.feature.isLoading == false)
    #expect(harness.feature.error == "Speech isn't set up on your gateway yet.")
  }

  // MARK: - Setters

  @Test("choosing a transcription model patches only that key")
  func setSTTModelSendsOneKey() async {
    let harness = Harness()
    await harness.feature.load()

    await harness.feature.setSTTModel("openai/whisper-tiny")

    #expect(
      await harness.api.patches == [
        SpeechConfigPatchDTO(stt: SpeechSttPatchDTO(model: "openai/whisper-tiny"))
      ]
    )
    // The screen shows what the GATEWAY now has, not what was asked for.
    #expect(harness.feature.config?.stt.model == "openai/whisper-tiny")
    #expect(harness.feature.config?.tts == SpeechFixtures.config.tts)
    #expect(harness.feature.isSaving == false)
    #expect(harness.feature.error == nil)
  }

  @Test("choosing a speech model patches only that key")
  func setTTSModelSendsOneKey() async {
    let harness = Harness()
    await harness.feature.load()

    await harness.feature.setTTSModel("openai/tts-1")

    #expect(
      await harness.api.patches == [
        SpeechConfigPatchDTO(tts: SpeechTtsPatchDTO(model: "openai/tts-1"))
      ]
    )
    #expect(harness.feature.config?.tts.model == "openai/tts-1")
    // A model change must not silently rewrite the voice: one key per setter.
    #expect(harness.feature.config?.tts.voice == "alloy")
  }

  @Test("choosing a voice patches only that key")
  func setVoiceSendsOneKey() async {
    let harness = Harness()
    await harness.feature.load()

    await harness.feature.setVoice("nova")

    #expect(
      await harness.api.patches == [
        SpeechConfigPatchDTO(tts: SpeechTtsPatchDTO(voice: "nova"))
      ]
    )
    #expect(harness.feature.config?.tts.voice == "nova")
  }

  @Test("choosing a language patches only that key")
  func setLanguageSendsOneKey() async {
    let harness = Harness()
    await harness.feature.load()

    await harness.feature.setLanguage("fr")

    #expect(
      await harness.api.patches == [
        SpeechConfigPatchDTO(stt: SpeechSttPatchDTO(language: "fr"))
      ]
    )
    #expect(harness.feature.config?.stt.language == "fr")
  }

  /// The gateway cannot express "clear this": `validateSttPatch` rejects
  /// `language: null` and an omitted key means "leave it alone", so a nil
  /// language would encode to `{"stt":{}}` — a no-op patch whose response
  /// would snap the picker back to the old language with no explanation.
  /// Sending nothing at all is the honest answer, and `SpeechSettingsView`
  /// only offers Auto while the gateway is already on Auto.
  @Test("Auto cannot be sent to a gateway that has no way to clear the language")
  func setLanguageToAutoSendsNothing() async {
    let harness = Harness()
    await harness.feature.load()
    await harness.feature.setLanguage("fr")

    await harness.feature.setLanguage(nil)

    #expect(await harness.api.patches.count == 1, "no empty stt patch may reach the gateway")
    #expect(harness.feature.config?.stt.language == "fr")
  }

  @Test("re-choosing the value already configured asks the gateway for nothing")
  func unchangedValueSendsNoPatch() async {
    let harness = Harness()
    await harness.feature.load()

    await harness.feature.setSTTModel(SpeechFixtures.config.stt.model)
    await harness.feature.setVoice(SpeechFixtures.config.tts.voice)

    #expect(await harness.api.patches.isEmpty)
  }

  @Test("a failed patch puts the old value back and says what went wrong")
  func failedPatchReverts() async {
    let harness = Harness()
    await harness.feature.load()
    await harness.api.setPatchFailure(
      GatewayError.speech(code: "provider_error", message: "OpenRouter is down", retryable: true)
    )

    await harness.feature.setVoice("nova")

    #expect(harness.feature.config == SpeechFixtures.config, "the optimistic value must be undone")
    #expect(harness.feature.error == "OpenRouter is down")
    #expect(harness.feature.isSaving == false)
  }

  @Test("a rejected provider key reads as a key problem, never as a pairing problem")
  func unauthorizedCopy() async {
    let harness = Harness()
    await harness.feature.load()
    await harness.api.setPatchFailure(
      GatewayError.speech(code: "unauthorized", message: "401", retryable: false)
    )

    await harness.feature.setVoice("nova")

    #expect(harness.feature.error == "Your gateway's speech provider key was rejected.")
  }

  @Test("a failure that is not a speech failure reads as a gateway problem")
  func genericCopy() async {
    let harness = Harness()
    await harness.feature.load()
    await harness.api.setPatchFailure(GatewayError.unauthorized)

    await harness.feature.setVoice("nova")

    #expect(harness.feature.error == "Couldn't reach your gateway. Try again.")
  }

  // MARK: - Providers

  @Test("a provider with no key on the gateway shows its reason, not a bare 'unavailable'")
  func unavailableProviderShowsItsReason() async {
    let harness = Harness()
    await harness.api.setResponse(
      SpeechConfigResponseDTO(
        config: SpeechFixtures.config,
        providers: [
          SpeechProviderStatusDTO(
            id: "openrouter",
            capabilities: SpeechCapabilitiesDTO(transcription: true, speech: true, realtime: false),
            available: false,
            reason: .noCredential
          ),
          SpeechFixtures.realtimeProvider,
        ]
      )
    )

    await harness.feature.load()

    #expect(harness.feature.transcriptionProvider?.available == false)
    #expect(
      harness.feature.transcriptionAvailability
        == "No API key for this provider on your gateway."
    )
    #expect(harness.feature.speechAvailability == "No API key for this provider on your gateway.")
    // Realtime is a pseudo-provider the gateway always reports: the row is
    // disabled and says why rather than being missing.
    #expect(harness.feature.realtimeAvailability == "No configured provider offers realtime speech yet.")
  }

  @Test("an available provider says so")
  func availableProviderReadsAsReady() async {
    let harness = Harness()

    await harness.feature.load()

    #expect(harness.feature.transcriptionAvailability == "Ready")
    #expect(harness.feature.speechAvailability == "Ready")
  }

  // MARK: - Voices

  @Test("the selected speech model's voices are the choices, current one included")
  func voiceOptionsComeFromTheSelectedModel() async {
    let harness = Harness()

    await harness.feature.load()

    #expect(harness.feature.voiceOptions == ["alloy", "nova"])

    // A model that lists no voices means the field is free text — the app
    // cannot invent a catalogue the provider did not publish.
    await harness.feature.setTTSModel("openrouter/plain-tts")
    #expect(harness.feature.voiceOptions.isEmpty)
  }

  @Test("a configured voice the model does not list is still offered, so the picker is never blank")
  func currentVoiceSurvivesAModelThatDoesNotListIt() async {
    let harness = Harness()
    await harness.api.setResponse(
      SpeechConfigResponseDTO(
        config: SpeechConfigDTO(
          stt: SpeechFixtures.config.stt,
          tts: SpeechTtsConfigDTO(
            provider: "openrouter",
            model: "openai/gpt-4o-mini-tts-2025-12-15",
            voice: "shimmer",
            speed: 1
          ),
          realtime: SpeechRealtimeConfigDTO(provider: nil)
        ),
        providers: SpeechFixtures.providers
      )
    )

    await harness.feature.load()

    #expect(harness.feature.voiceOptions == ["shimmer", "alloy", "nova"])
  }

  // MARK: - Preview

  @Test("preview speaks one fixed sentence through the gateway and plays it")
  func previewSynthesizesTheFixedSentence() async {
    let harness = Harness()
    await harness.feature.load()

    let preview = Task { await harness.feature.previewVoice() }
    await harness.waitForPlayback()

    #expect(await harness.synthesizer.texts == ["Hi, I'm your Dash agent."])
    #expect(harness.feature.isPreviewing)
    #expect(harness.session.playbackActivations == 1)

    await harness.player.finish()
    await preview.value

    #expect(harness.feature.isPreviewing == false)
    #expect(await harness.player.played.count == 1)
    // Whatever was playing before gets its route back.
    #expect(harness.session.deactivations == 1)
    #expect(harness.feature.error == nil)
  }

  @Test("a preview the gateway refuses says why and never touches the audio session")
  func previewFailureSurfaces() async {
    let harness = Harness()
    await harness.feature.load()
    await harness.synthesizer.setResult(
      .failure(
        GatewayError.speech(code: "unavailable", message: "speech is not configured", retryable: false)
      )
    )

    await harness.feature.previewVoice()

    #expect(harness.feature.error == "Speech isn't set up on your gateway yet.")
    #expect(harness.feature.isPreviewing == false)
    #expect(harness.session.playbackActivations == 0)
    #expect(harness.session.deactivations == 0)
  }

  // MARK: - Lifecycle

  @Test("shutting the screen down stops the preview and releases what its factory built")
  func shutdownStopsPreviewAndRetires() async {
    let harness = Harness()
    await harness.feature.load()
    let preview = Task { await harness.feature.previewVoice() }
    await harness.waitForPlayback()

    await harness.feature.shutdown()
    await preview.value

    #expect(harness.feature.isPreviewing == false)
    #expect(await harness.player.stopCount == 1)
    #expect(harness.session.deactivations == 1)
    #expect(await harness.retirements.count == 1)
  }

  // MARK: - Harness

  @MainActor
  private struct Harness {
    let feature: SpeechSettingsFeature
    let api: FakeSpeechConfigAPI
    let synthesizer: FakeSpeechSynthesizer
    let player: FakeAudioPlayer
    let session: FakeSpeechSessionControl
    let retirements = RetirementRecorder()

    init() {
      api = FakeSpeechConfigAPI()
      synthesizer = FakeSpeechSynthesizer(result: .success(Data([0x49, 0x44, 0x33])))
      player = FakeAudioPlayer()
      session = FakeSpeechSessionControl()
      let retiring = retirements
      feature = SpeechSettingsFeature(
        api: api,
        synthesizer: synthesizer,
        player: player,
        session: session,
        onRetire: { await retiring.record() }
      )
    }

    func waitForPlayback() async {
      await expectEventuallyAsync("the preview to be playing") { await player.isPlaying }
    }
  }
}

enum SpeechFixtures {
  /// `contracts/mobile/v1/fixtures/speech-config.json`, as Swift.
  static let config = SpeechConfigDTO(
    stt: SpeechSttConfigDTO(
      provider: "openrouter",
      model: "openai/whisper-large-v3",
      language: "en"
    ),
    tts: SpeechTtsConfigDTO(
      provider: "openrouter",
      model: "openai/gpt-4o-mini-tts-2025-12-15",
      voice: "alloy",
      speed: 1
    ),
    realtime: SpeechRealtimeConfigDTO(provider: nil)
  )

  static let realtimeProvider = SpeechProviderStatusDTO(
    id: "realtime",
    capabilities: SpeechCapabilitiesDTO(transcription: false, speech: false, realtime: true),
    available: false,
    reason: .noProviderOffersRealtime
  )

  static let providers: [SpeechProviderStatusDTO] = [
    SpeechProviderStatusDTO(
      id: "openrouter",
      capabilities: SpeechCapabilitiesDTO(transcription: true, speech: true, realtime: false),
      available: true
    ),
    realtimeProvider,
  ]

  /// `contracts/mobile/v1/fixtures/speech-models.json`, split by kind the way
  /// the route splits it — plus a voice-less speech model, so the free-text
  /// voice path has something to select.
  static let models: [SpeechModelKind: [SpeechModelDTO]] = [
    .transcription: [
      SpeechModelDTO(
        id: "openai/whisper-large-v3",
        name: "Whisper Large v3",
        kind: .transcription,
        voices: nil
      ),
      SpeechModelDTO(id: "openai/whisper-tiny", name: "Whisper Tiny", kind: .transcription, voices: nil),
    ],
    .speech: [
      SpeechModelDTO(
        id: "openai/gpt-4o-mini-tts-2025-12-15",
        name: "GPT-4o mini TTS",
        kind: .speech,
        voices: ["alloy", "nova"]
      ),
      SpeechModelDTO(id: "openai/tts-1", name: "TTS 1", kind: .speech, voices: ["alloy", "nova"]),
      SpeechModelDTO(id: "openrouter/plain-tts", name: "Plain TTS", kind: .speech, voices: nil),
    ],
  ]
}

/// The gateway's speech-config half. Merges patches the way
/// `mergeSpeechConfig` does, so "the screen shows what the gateway now has"
/// is a real assertion rather than an echo of the request.
actor FakeSpeechConfigAPI: SpeechConfiguring {
  private(set) var patches: [SpeechConfigPatchDTO] = []
  private(set) var modelRequests: [SpeechModelKind] = []
  private(set) var configLoads = 0
  private var response: SpeechConfigResponseDTO
  private var loadFailure: Error?
  private var patchFailure: Error?

  init(
    response: SpeechConfigResponseDTO = SpeechConfigResponseDTO(
      config: SpeechFixtures.config,
      providers: SpeechFixtures.providers
    )
  ) {
    self.response = response
  }

  func setResponse(_ value: SpeechConfigResponseDTO) {
    response = value
  }

  func setLoadFailure(_ error: Error?) {
    loadFailure = error
  }

  func setPatchFailure(_ error: Error?) {
    patchFailure = error
  }

  func speechConfig() async throws -> SpeechConfigResponseDTO {
    configLoads += 1
    if let loadFailure { throw loadFailure }
    return response
  }

  func patchSpeechConfig(_ patch: SpeechConfigPatchDTO) async throws -> SpeechConfigResponseDTO {
    patches.append(patch)
    if let patchFailure { throw patchFailure }
    response = SpeechConfigResponseDTO(
      config: Self.merge(response.config, patch),
      providers: response.providers
    )
    return response
  }

  func speechModels(kind: SpeechModelKind) async throws -> [SpeechModelDTO] {
    modelRequests.append(kind)
    if let loadFailure { throw loadFailure }
    return SpeechFixtures.models[kind] ?? []
  }

  private static func merge(
    _ base: SpeechConfigDTO,
    _ patch: SpeechConfigPatchDTO
  ) -> SpeechConfigDTO {
    SpeechConfigDTO(
      stt: SpeechSttConfigDTO(
        provider: patch.stt?.provider ?? base.stt.provider,
        model: patch.stt?.model ?? base.stt.model,
        language: patch.stt?.language ?? base.stt.language
      ),
      tts: SpeechTtsConfigDTO(
        provider: patch.tts?.provider ?? base.tts.provider,
        model: patch.tts?.model ?? base.tts.model,
        voice: patch.tts?.voice ?? base.tts.voice,
        speed: patch.tts?.speed ?? base.tts.speed
      ),
      realtime: patch.realtime ?? base.realtime
    )
  }
}
