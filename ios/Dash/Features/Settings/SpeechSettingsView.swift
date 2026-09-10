import SwiftUI

/// Settings › Speech (design §4): what the gateway hears with, what it speaks
/// with, and the one sentence that proves the voice.
///
/// Every control commits immediately — there is no Save step, like
/// `ChatModelPickerSheet` — and each one patches a single key, so a failure
/// can only ever undo the control the user just touched.
struct SpeechSettingsView: View {
  @Environment(SpeechSettingsFeature.self) private var feature
  /// The free-text voice field's live text, for the models that publish no
  /// voice list. Committed on submit rather than per keystroke: a patch per
  /// character would be one gateway round trip per character.
  @State private var voiceDraft = ""

  var body: some View {
    Form {
      if feature.config == nil {
        Section {
          if feature.isLoading {
            HStack {
              ProgressView()
              Text("Loading speech settings")
                .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
          } else {
            Text(feature.error ?? SpeechSettingsFeature.failureMessage)
              .foregroundStyle(.secondary)
          }
        }
      } else {
        speechToTextSection
        textToSpeechSection
        realtimeSection
        languageSection
      }
    }
    .accessibilityIdentifier("settings.speech.list")
    .navigationTitle("Speech")
    .navigationBarTitleDisplayMode(.inline)
    .task { await feature.load() }
    // Seeded from the config and RE-seeded whenever it changes, rather than
    // once after the first load: the field is only on screen for models that
    // publish no voices, so it is typically first shown long after loading —
    // after a model change, after a failed load that a pull-to-refresh
    // repaired. A stale draft would submit the previous model's voice.
    .onChange(of: feature.config?.tts.voice, initial: true) { _, voice in
      voiceDraft = voice ?? ""
    }
    .refreshable { await feature.load() }
    .alert("Speech settings", isPresented: errorPresented) {
      Button("OK") { feature.error = nil }
    } message: {
      Text(feature.error ?? SpeechSettingsFeature.failureMessage)
    }
  }

  // MARK: - Sections

  @ViewBuilder
  private var speechToTextSection: some View {
    Section {
      providerRow(
        name: feature.config?.stt.provider,
        availability: feature.transcriptionAvailability,
        isAvailable: feature.transcriptionProvider?.available ?? false
      )
      Picker("Model", selection: sttModel) {
        ForEach(rows(feature.transcriptionModels, including: feature.config?.stt.model)) { model in
          Text(model.name).tag(model.id)
        }
      }
      .pickerStyle(.navigationLink)
      .disabled(feature.isSaving)
      .accessibilityIdentifier("settings.speech.sttModel")
    } header: {
      Text("Speech to text")
    } footer: {
      Text("The model that turns what you dictate into text.")
    }
  }

  @ViewBuilder
  private var textToSpeechSection: some View {
    Section {
      providerRow(
        name: feature.config?.tts.provider,
        availability: feature.speechAvailability,
        isAvailable: feature.speechProvider?.available ?? false
      )
      Picker("Model", selection: ttsModel) {
        ForEach(rows(feature.speechModels, including: feature.config?.tts.model)) { model in
          Text(model.name).tag(model.id)
        }
      }
      .pickerStyle(.navigationLink)
      .disabled(feature.isSaving)
      .accessibilityIdentifier("settings.speech.ttsModel")
      voiceControl
      previewButton
    } header: {
      Text("Text to speech")
    } footer: {
      Text("The voice that reads replies aloud.")
    }
  }

  /// The gateway always reports realtime, always unavailable
  /// (`REALTIME_PSEUDO_STATUS`). Shown rather than hidden so the absence is
  /// explained once, here, instead of being discovered in Phase B.
  @ViewBuilder
  private var realtimeSection: some View {
    Section {
      LabeledContent("Conversation mode") {
        Text("Unavailable")
          .foregroundStyle(.secondary)
      }
      .disabled(true)
      .accessibilityElement(children: .combine)
      .accessibilityLabel("Conversation mode. \(feature.realtimeAvailability)")
      .accessibilityIdentifier("settings.speech.realtime")
    } header: {
      Text("Realtime")
    } footer: {
      Text(feature.realtimeAvailability)
    }
  }

  @ViewBuilder
  private var languageSection: some View {
    Section {
      Picker("Language", selection: language) {
        if feature.canChooseAutomaticLanguage {
          Text("Auto").tag(String?.none)
        }
        // The gateway accepts any 2-8 character code (`zh-Hans`, `pt-BR`),
        // while this list is language-only; a configured code outside it
        // still has to be selectable, or the picker renders blank. Same
        // reason as `rows(_:including:)` above.
        if let current = feature.config?.stt.language,
          SpeechSettingsFeature.languageCodes.contains(current) == false
        {
          Text(SpeechSettingsFeature.languageLabel(for: current)).tag(String?.some(current))
        }
        ForEach(SpeechSettingsFeature.languageCodes, id: \.self) { code in
          Text(SpeechSettingsFeature.languageLabel(for: code)).tag(String?.some(code))
        }
      }
      .pickerStyle(.navigationLink)
      .disabled(feature.isSaving)
      .accessibilityIdentifier("settings.speech.language")
    } header: {
      Text("Language")
    } footer: {
      // The honest reason Auto disappears once a language is chosen: the
      // gateway's `PATCH /speech/config` can set `stt.language` but has no
      // way to clear it. See `SpeechSettingsFeature.setLanguage(_:)`.
      Text(
        feature.canChooseAutomaticLanguage
          ? "Auto lets the provider detect what you're speaking."
          : "Your gateway can't switch a set language back to Auto yet."
      )
    }
  }

  // MARK: - Rows

  private func providerRow(
    name: String?,
    availability: String,
    isAvailable: Bool
  ) -> some View {
    LabeledContent("Provider") {
      VStack(alignment: .trailing, spacing: 2) {
        Text(name.map(ModelCatalog.providerDisplayName) ?? "None")
        Text(availability)
          .font(.footnote)
          .foregroundStyle(isAvailable ? Color.secondary : DashTheme.danger)
      }
    }
    .accessibilityElement(children: .combine)
  }

  /// A picker when the selected model publishes voices, a free-text field
  /// when it does not — the app cannot invent a catalogue the provider did
  /// not publish, and a provider that names its voices in its own docs still
  /// has to be typeable.
  @ViewBuilder
  private var voiceControl: some View {
    if feature.voiceOptions.isEmpty {
      LabeledContent("Voice") {
        TextField("Voice id", text: $voiceDraft)
          .multilineTextAlignment(.trailing)
          .autocorrectionDisabled()
          .textInputAutocapitalization(.never)
          .submitLabel(.done)
          .onSubmit { Task { await feature.setVoice(voiceDraft) } }
      }
      .disabled(feature.isSaving)
      .accessibilityIdentifier("settings.speech.voice")
    } else {
      Picker("Voice", selection: voice) {
        ForEach(feature.voiceOptions, id: \.self) { option in
          Text(option).tag(option)
        }
      }
      .pickerStyle(.navigationLink)
      .disabled(feature.isSaving)
      .accessibilityIdentifier("settings.speech.voice")
    }
  }

  private var previewButton: some View {
    Button {
      Task { await feature.previewVoice() }
    } label: {
      HStack {
        if feature.isPreviewing {
          ProgressView()
        } else {
          Image(systemName: "speaker.wave.2")
        }
        Text("Preview voice")
        Spacer()
      }
      .frame(minHeight: 44)
    }
    .disabled(feature.isPreviewing || feature.speechProvider?.available == false)
    .accessibilityLabel("Preview voice")
    .accessibilityIdentifier("settings.speech.preview")
  }

  // MARK: - Bindings
  //
  // `config` is `private(set)` — the feature owns every write, because every
  // write is a gateway patch. These are therefore hand-built bindings whose
  // setter calls the matching command rather than `@Bindable` passthroughs.

  private var sttModel: Binding<String> {
    Binding(
      get: { feature.config?.stt.model ?? "" },
      set: { value in Task { await feature.setSTTModel(value) } }
    )
  }

  private var ttsModel: Binding<String> {
    Binding(
      get: { feature.config?.tts.model ?? "" },
      set: { value in Task { await feature.setTTSModel(value) } }
    )
  }

  private var voice: Binding<String> {
    Binding(
      get: { feature.config?.tts.voice ?? "" },
      set: { value in Task { await feature.setVoice(value) } }
    )
  }

  private var language: Binding<String?> {
    Binding(
      get: { feature.config?.stt.language },
      set: { value in Task { await feature.setLanguage(value) } }
    )
  }

  private var errorPresented: Binding<Bool> {
    Binding(
      get: { feature.error != nil && feature.config != nil },
      set: { if $0 == false { feature.error = nil } }
    )
  }

  /// The gateway's list, plus the configured model when the list does not
  /// contain it — a `Picker` whose selection is not among its tags renders
  /// blank, and a configured-but-unlisted model (an older id, a provider
  /// that cannot be reached right now) is exactly when that happens.
  private func rows(
    _ models: [SpeechModelDTO],
    including selected: String?
  ) -> [SpeechModelDTO] {
    guard let selected, models.contains(where: { $0.id == selected }) == false else {
      return models
    }
    let kind: SpeechModelKind = models.first?.kind ?? .speech
    return [SpeechModelDTO(id: selected, name: selected, kind: kind, voices: nil)] + models
  }
}

/// Resolves the one `SpeechSettingsFeature` `AppModel` owns for the active
/// profile, building it on first appearance.
///
/// It reads `AppModel.speechSettingsFeature` directly rather than caching the
/// resolved feature in `@State`: the model drops that reference the moment the
/// profile is deactivated (its `GatewayAPI` is shut down with it), and a
/// cached copy would keep a retired screen alive and callable.
struct SpeechSettingsHost: View {
  @Environment(AppModel.self) private var appModel

  var body: some View {
    Group {
      if let feature = appModel.speechSettingsFeature {
        SpeechSettingsView()
          .environment(feature)
          .id(ObjectIdentifier(feature))
      } else {
        // One frame at most on the way in, and — after a disconnect — the
        // honest state of a screen whose gateway has gone away.
        ProgressView()
          .controlSize(.large)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .navigationTitle("Speech")
          .navigationBarTitleDisplayMode(.inline)
      }
    }
    .task { await appModel.prepareSpeechSettings() }
  }
}
