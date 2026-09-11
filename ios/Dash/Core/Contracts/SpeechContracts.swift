import Foundation

/// Wire types for the `/mobile/v1/speech/*` operations
/// (`contracts/mobile/v1/openapi.yaml`). They mirror `@dash/speech`'s own
/// types, but the contract document — not the server package — is what these
/// are written against.
enum SpeechModelKind: String, Codable, Hashable, Sendable, CaseIterable {
  case transcription
  case speech
}

/// Container formats the transcription route accepts. Not the codec — the
/// gateway hands the bytes to the provider as-is.
enum SpeechAudioFormat: String, Codable, Hashable, Sendable, CaseIterable {
  case wav
  case m4a
  case mp3
  case flac
  case ogg
  case webm
  case aac
}

/// Why a provider is unavailable. Present only alongside `available == false`.
enum SpeechProviderReason: String, Codable, Hashable, Sendable {
  case noCredential = "no_credential"
  case noProviderOffersRealtime = "no_provider_offers_realtime"
}

struct SpeechSttConfigDTO: Codable, Hashable, Sendable {
  let provider: String
  let model: String
  let language: String?
}

struct SpeechTtsConfigDTO: Codable, Hashable, Sendable {
  let provider: String
  let model: String
  let voice: String
  let speed: Double?
}

/// `provider == nil` is a real value meaning "no realtime provider", which is
/// why this is a struct with an explicit encoder rather than a bare `String?`
/// — see `encode(to:)`.
struct SpeechRealtimeConfigDTO: Codable, Hashable, Sendable {
  let provider: String?

  init(provider: String?) {
    self.provider = provider
  }

  private enum CodingKeys: String, CodingKey {
    case provider
  }

  /// Written by hand because the synthesized encoder would `encodeIfPresent`
  /// and DROP the key when `provider` is nil. The gateway's
  /// `validateRealtimePatch` requires the key to be present inside a
  /// `realtime` object and accepts `null` as its value, so an omission is a
  /// 400 `validation_failed`, not "leave it alone".
  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    if let provider {
      try container.encode(provider, forKey: .provider)
    } else {
      try container.encodeNil(forKey: .provider)
    }
  }
}

struct SpeechConfigDTO: Codable, Hashable, Sendable {
  let stt: SpeechSttConfigDTO
  let tts: SpeechTtsConfigDTO
  let realtime: SpeechRealtimeConfigDTO
}

struct SpeechCapabilitiesDTO: Codable, Hashable, Sendable {
  let transcription: Bool
  let speech: Bool
  let realtime: Bool
}

struct SpeechProviderStatusDTO: Codable, Hashable, Sendable, Identifiable {
  let id: String
  let capabilities: SpeechCapabilitiesDTO
  let available: Bool
  let reason: SpeechProviderReason?

  init(
    id: String,
    capabilities: SpeechCapabilitiesDTO,
    available: Bool,
    reason: SpeechProviderReason? = nil
  ) {
    self.id = id
    self.capabilities = capabilities
    self.available = available
    self.reason = reason
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    capabilities = try container.decode(SpeechCapabilitiesDTO.self, forKey: .capabilities)
    available = try container.decode(Bool.self, forKey: .available)
    // Decoded as a STRING and then mapped, which is the same shape as
    // `HealthResponse`'s capability leniency and for the same reason: an
    // unfamiliar reason on a provider already known to be unavailable degrades
    // to "no stated reason", rather than mapping to
    // `GatewayError.updateRequired` and taking out the whole speech settings
    // screen over a label.
    //
    // NOT `try?` over the whole decode — that would also swallow a malformed
    // `reason` (a number, an object), which is a broken gateway rather than a
    // newer one. The leniency is scoped to unknown strings only.
    let rawReason = try container.decodeIfPresent(String.self, forKey: .reason)
    reason = rawReason.flatMap(SpeechProviderReason.init(rawValue:))
  }
}

/// The body of both `GET` and `PATCH /speech/config` — a patch never needs a
/// follow-up read.
struct SpeechConfigResponseDTO: Codable, Hashable, Sendable {
  let config: SpeechConfigDTO
  let providers: [SpeechProviderStatusDTO]
}

/// A string whose JSON `null` is a VALUE rather than an absence — the shape
/// `SpeechSttPatchDTO.language` needs and `String?` cannot express, since the
/// synthesized encoder `encodeIfPresent`s a nil and DROPS the key.
///
/// Wrapped rather than modelled as `String??`, which Codable cannot encode
/// and no call site could read.
struct NullableString: Codable, Hashable, Sendable, ExpressibleByStringLiteral {
  let value: String?

  /// The explicit JSON `null`. Named so a call site reads as what it means:
  /// `SpeechSttPatchDTO(language: .null)` CLEARS the language, while
  /// `SpeechSttPatchDTO(language: nil)` omits the key.
  static let null = NullableString(nil)

  init(_ value: String?) {
    self.value = value
  }

  init(stringLiteral value: StringLiteralType) {
    self.value = value
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    value = container.decodeNil() ? nil : try container.decode(String.self)
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    if let value {
      try container.encode(value)
    } else {
      try container.encodeNil()
    }
  }
}

/// Every field of an `stt`/`tts` section is optional: an omitted key keeps its
/// current value.
struct SpeechSttPatchDTO: Codable, Hashable, Sendable {
  let provider: String?
  let model: String?
  /// Three states, not two (`validateSttPatch` in
  /// `packages/speech/src/config.ts`): `nil` omits the key and keeps whatever
  /// the gateway has, `.null` clears the language back to the provider's own
  /// detection, and a string sets it. `stt.language` is ABSENT when auto, so
  /// "clear it" has no other spelling.
  let language: NullableString?

  init(provider: String? = nil, model: String? = nil, language: NullableString? = nil) {
    self.provider = provider
    self.model = model
    self.language = language
  }

  private enum CodingKeys: String, CodingKey {
    case provider
    case model
    case language
  }

  /// Written by hand because the synthesized decoder `decodeIfPresent`s every
  /// optional, and that CANNOT tell an absent `language` from a null one —
  /// both come back nil, collapsing "leave it alone" and "clear it" into the
  /// same value. `contains(_:)` is the only thing that separates them.
  ///
  /// The encoder stays synthesized: `encodeIfPresent` drops a nil (omitting
  /// the key) and hands a `.null` to `NullableString.encode(to:)`, which
  /// writes the JSON null.
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    provider = try container.decodeIfPresent(String.self, forKey: .provider)
    model = try container.decodeIfPresent(String.self, forKey: .model)
    language = container.contains(.language)
      ? NullableString(try container.decodeIfPresent(String.self, forKey: .language))
      : nil
  }
}

struct SpeechTtsPatchDTO: Codable, Hashable, Sendable {
  let provider: String?
  let model: String?
  let voice: String?
  let speed: Double?

  init(provider: String? = nil, model: String? = nil, voice: String? = nil, speed: Double? = nil) {
    self.provider = provider
    self.model = model
    self.voice = voice
    self.speed = speed
  }
}

/// A shallow per-section merge. `realtime` is the asymmetric one: the section
/// is optional, but a present section must carry `provider` (possibly null).
struct SpeechConfigPatchDTO: Codable, Hashable, Sendable {
  let stt: SpeechSttPatchDTO?
  let tts: SpeechTtsPatchDTO?
  let realtime: SpeechRealtimeConfigDTO?

  init(
    stt: SpeechSttPatchDTO? = nil,
    tts: SpeechTtsPatchDTO? = nil,
    realtime: SpeechRealtimeConfigDTO? = nil
  ) {
    self.stt = stt
    self.tts = tts
    self.realtime = realtime
  }
}

struct SpeechModelDTO: Codable, Hashable, Sendable, Identifiable {
  let id: String
  let name: String
  let kind: SpeechModelKind
  /// Present only on `speech` models that expose named voices.
  let voices: [String]?
}

/// The `GET /speech/models` envelope. `GatewayAPI.speechModels(kind:)` unwraps
/// it; nothing above the networking layer sees this type.
struct SpeechModelListDTO: Codable, Hashable, Sendable {
  let models: [SpeechModelDTO]
}

struct TranscriptionRequestDTO: Codable, Hashable, Sendable {
  /// Standard base64, no line breaks. Upstream caps the DECODED clip at 8 MiB
  /// and 60 seconds; the gateway also fast-rejects on `Content-Length`.
  let audio: String
  let format: SpeechAudioFormat
  let language: String?

  init(audio: String, format: SpeechAudioFormat, language: String? = nil) {
    self.audio = audio
    self.format = format
    self.language = language
  }
}

struct TranscriptionResponseDTO: Codable, Hashable, Sendable {
  let text: String
  /// Present only when the provider reported one.
  let durationSeconds: Double?
}

/// The request body of `POST /speech/speech`. The RESPONSE is `audio/mpeg`
/// bytes, or `audio/wav` for a PCM-only model, which is why
/// `GatewayAPI.synthesize` returns `Data`.
struct SynthesisRequestDTO: Codable, Hashable, Sendable {
  /// At most 4 000 characters; over that the gateway answers 413 `too_long`.
  let text: String
}
