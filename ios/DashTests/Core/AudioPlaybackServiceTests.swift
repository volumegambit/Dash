import AVFoundation
import Foundation
import Testing

@testable import Dash

/// `AudioPlaybackService` and `SpeechAudioSession` are otherwise only
/// exercised on a device (`ReadAloudFeatureTests.swift`'s header comment) —
/// this suite is the one exception, and it stays narrow on purpose: it
/// confirms only that `AVAudioPlayer` itself accepts a WAV byte stream, not
/// that a full read-aloud turn plays audio on this machine's route.
@Suite("Audio playback WAV decoding")
struct AudioPlaybackServiceTests {
  /// Task B7 addendum: `POST /speech/speech` may now answer `audio/wav` for a
  /// PCM-only model. `AudioPlaybackService.playMP3` hands whatever bytes it
  /// is given to `AVAudioPlayer(data:fileTypeHint:)` with the hint fixed to
  /// `.mp3` (the route's usual case) — this pins that the initializer still
  /// accepts a real WAV byte stream despite that hint, so a PCM-only model's
  /// response does not fail before playback even starts.
  @Test("AVAudioPlayer accepts a 44-byte-header WAV clip despite the mp3 file type hint")
  func wavClipInitializesDespiteMP3Hint() throws {
    let wav = makeMinimalWav()
    let player = try AVAudioPlayer(data: wav, fileTypeHint: AVFileType.mp3.rawValue)
    #expect(player.duration > 0)
  }

  /// Builds a minimal, valid canonical WAV clip: the standard 44-byte
  /// RIFF/WAVE/fmt/data header, plus a handful of silent 16-bit mono samples
  /// so the clip has a real, nonzero duration rather than being header-only.
  private func makeMinimalWav(sampleCount: Int = 800, sampleRate: UInt32 = 8000) -> Data {
    let bitsPerSample: UInt32 = 16
    let channels: UInt32 = 1
    let byteRate = sampleRate * channels * (bitsPerSample / 8)
    let blockAlign = UInt16(channels * (bitsPerSample / 8))
    let dataSize = UInt32(sampleCount * Int(blockAlign))
    let chunkSize = 36 + dataSize

    var data = Data()
    data.append(contentsOf: "RIFF".utf8)
    data.appendLittleEndian(chunkSize)
    data.append(contentsOf: "WAVE".utf8)
    data.append(contentsOf: "fmt ".utf8)
    data.appendLittleEndian(UInt32(16))  // Subchunk1Size (PCM)
    data.appendLittleEndian(UInt16(1))  // AudioFormat = PCM
    data.appendLittleEndian(UInt16(channels))
    data.appendLittleEndian(sampleRate)
    data.appendLittleEndian(byteRate)
    data.appendLittleEndian(blockAlign)
    data.appendLittleEndian(UInt16(bitsPerSample))
    data.append(contentsOf: "data".utf8)
    data.appendLittleEndian(dataSize)
    data.append(Data(repeating: 0, count: Int(dataSize)))
    return data
  }
}

extension Data {
  fileprivate mutating func appendLittleEndian(_ value: UInt32) {
    var littleEndian = value.littleEndian
    Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
  }

  fileprivate mutating func appendLittleEndian(_ value: UInt16) {
    var littleEndian = value.littleEndian
    Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
  }
}
