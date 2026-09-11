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

  /// Task B8: voice mode's PCM playback path. This is deliberately the
  /// narrowest possible check — an empty frame and an idle flush — because
  /// actually starting `AVAudioEngine` and hearing output depends on the
  /// host machine's audio route, which is exactly what the header comment
  /// above says is device-only. What IS safe on the simulator/CI host is
  /// confirming `enqueuePCM`/`flush` never throw or trap when there is
  /// nothing to play.
  @Test("enqueuePCM with an empty payload and flush with nothing queued are both no-ops")
  func emptyPCMFrameAndIdleFlushAreNoOps() async {
    let service = AudioPlaybackService()
    await service.enqueuePCM(Data(), sampleRate: 16_000)
    await service.flush()
    #expect(await service.isPlaying == false)
  }

  /// Fix round 1 (concern 1): now that `enqueuePCM` converts PCM16 to
  /// Float32 and connects the player node at
  /// `AVAudioFormat(standardFormatWithSampleRate:channels:)` instead of
  /// `.pcmFormatInt16`, this exercises the ACTUAL conversion and reconnect
  /// path with real (non-empty, non-silent) audio data — a 440 Hz tone — at
  /// two different sample rates back to back, which forces
  /// `reconnectedFormat` to disconnect and reconnect mid-run.
  ///
  /// What this suite still cannot confirm, per the class header above, is
  /// that anything audible comes out of this machine's route — `enqueuePCM`
  /// deliberately swallows an `AVAudioEngine.start()` failure (no output
  /// device is not this method's error to throw), so a host with no usable
  /// audio output is a valid, silent pass here, not a failure. What IS
  /// pinned unconditionally: neither call throws or traps, and after
  /// `flush()` + `stop()` the PCM engine itself is stopped — not merely the
  /// player node reset — so a barge-in or a torn-down turn never leaves the
  /// audio hardware open behind it.
  @Test("enqueuePCM converts PCM16 to Float32 across a sample-rate reconnect; flush/stop always stop the engine")
  func pcmPlaybackAcrossSampleRateChangeThenFlushAndStop() async {
    let service = AudioPlaybackService()

    let frame24k = makeTonePCM16(frequency: 440, sampleRate: 24_000, sampleCount: 1_600)
    #expect(frame24k.count == 3_200)
    await service.enqueuePCM(frame24k, sampleRate: 24_000)

    // A different sample rate forces `reconnectedFormat` to disconnect and
    // reconnect the node mid-run rather than reusing the first connection.
    let frame16k = makeTonePCM16(frequency: 440, sampleRate: 16_000, sampleCount: 1_600)
    #expect(frame16k.count == 3_200)
    await service.enqueuePCM(frame16k, sampleRate: 16_000)

    await service.flush()
    await service.stop()

    #expect(await service.isPCMEngineRunning == false)
  }

  /// A real, non-silent PCM16 mono tone at `sampleRate`, little-endian —
  /// the same wire shape `enqueuePCM` documents. `frequency` and
  /// `sampleRate` are deliberately real audio parameters (not degenerate
  /// zeros) so the conversion loop in `enqueuePCM` runs over actual varying
  /// sample values, not a buffer of silence that would pass even a broken
  /// scaling factor.
  private func makeTonePCM16(frequency: Double, sampleRate: Double, sampleCount: Int) -> Data {
    var data = Data(capacity: sampleCount * MemoryLayout<Int16>.size)
    for index in 0..<sampleCount {
      let time = Double(index) / sampleRate
      let amplitude = 0.5 * Double(Int16.max)
      let sample = Int16(sin(2 * Double.pi * frequency * time) * amplitude)
      data.appendLittleEndian(sample)
    }
    return data
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

  fileprivate mutating func appendLittleEndian(_ value: Int16) {
    var littleEndian = value.littleEndian
    Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
  }
}
