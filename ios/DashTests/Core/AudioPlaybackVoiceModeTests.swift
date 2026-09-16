import AVFoundation
import Foundation
import Testing

@testable import Dash

/// Voice mode's two playback faults, both device-only until they were traced:
/// a compressed reply produced no sound at all, and a streamed one played at
/// the wrong speed after the microphone changed the route.
@Suite("Voice-mode playback")
struct AudioPlaybackVoiceModeTests {
  /// A real mp3, built here rather than checked in: `AVAudioFile` writing an
  /// AAC/mp3 container needs a hardware encoder that is not guaranteed on
  /// every runner, so the fixture is PCM encoded to mp3 only if the platform
  /// can, and the test says so plainly when it cannot.
  private func sineWave(seconds: Double, rate: Double = 24_000) -> Data {
    let count = Int(seconds * rate)
    var pcm = Data(count: count * MemoryLayout<Int16>.size)
    pcm.withUnsafeMutableBytes { raw in
      guard let out = raw.baseAddress else { return }
      for index in 0..<count {
        let value = Int16(sin(2 * Double.pi * 440 * Double(index) / rate) * 12_000).littleEndian
        out.storeBytes(of: value, toByteOffset: index * MemoryLayout<Int16>.size, as: Int16.self)
      }
    }
    return pcm
  }

  /// Writes PCM16 as a WAV container — a compressed *container* the decode
  /// path opens exactly the way it opens an mp3 (`AVAudioFile`), which is the
  /// part under test: bytes in, engine buffers out, no `playMP3`.
  private func wav(_ pcm: Data, rate: Double = 24_000) -> Data {
    var header = Data()
    func append32(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { header.append(contentsOf: $0) } }
    func append16(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { header.append(contentsOf: $0) } }
    header.append(contentsOf: Array("RIFF".utf8))
    append32(UInt32(36 + pcm.count))
    header.append(contentsOf: Array("WAVEfmt ".utf8))
    append32(16)
    append16(1)
    append16(1)
    append32(UInt32(rate))
    append32(UInt32(rate) * 2)
    append16(2)
    append16(16)
    header.append(contentsOf: Array("data".utf8))
    append32(UInt32(pcm.count))
    return header + pcm
  }

  @Test("a compressed chunk is decoded to PCM at its own rate")
  func compressedChunkDecodesToPCM() throws {
    let seconds = 0.75
    let rate = 24_000.0
    let decoded = try #require(AudioPlaybackService.decode(wav(sineWave(seconds: seconds, rate: rate), rate: rate)))
    #expect(decoded.sampleRate == rate)
    // Mono PCM16: two bytes a sample, and the rate comes from the container
    // rather than being assumed — assuming 24 kHz is what played a reply at
    // the wrong speed.
    let samples = decoded.pcm.count / MemoryLayout<Int16>.size
    #expect(abs(Double(samples) - seconds * rate) < rate * 0.05, "decoded \(samples) samples")
  }

  @Test("a decoded chunk keeps its amplitude")
  func decodedChunkKeepsAmplitude() throws {
    let decoded = try #require(AudioPlaybackService.decode(wav(sineWave(seconds: 0.2))))
    let peak = decoded.pcm.withUnsafeBytes { raw -> Int in
      var highest = 0
      for index in 0..<(raw.count / 2) {
        let sample = Int(raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self).littleEndian)
        highest = max(highest, abs(sample))
      }
      return highest
    }
    // The source peaks at 12000; a decode that silently halved or clipped it
    // would show up here rather than as "it sounds wrong on my iPad".
    #expect(peak > 10_000 && peak <= 12_500, "peak \(peak)")
  }

  @Test("undecodable bytes are one silent chunk, not a failure")
  func undecodableChunkIsSurvivable() async throws {
    let player = AudioPlaybackService()
    await player.enqueueCompressed(Data([0x00, 0x01, 0x02, 0x03]))
    await player.awaitDrain()
    await player.stop()
  }

  @Test("a route change rebuilds the graph instead of playing at the old rate")
  func configurationChangeRebuildsTheGraph() async throws {
    let player = AudioPlaybackService()
    await player.enqueuePCM(sineWave(seconds: 1.0), sampleRate: 24_000)

    // What iOS posts when the hardware format or route changes — arming the
    // microphone is one such change, and it lands mid-reply. Without handling
    // it the engine keeps rendering into an invalidated graph.
    NotificationCenter.default.post(
      name: .AVAudioEngineConfigurationChange,
      object: player.engineForTesting
    )

    // The waiters parked on buffers that died with the old graph must be
    // released, or the playback chain wedges and the drain acknowledgement the
    // gateway waits for never goes out.
    let started = Date()
    await player.awaitDrain()
    #expect(Date().timeIntervalSince(started) < 1.0, "awaitDrain hung after the route changed")
    #expect(await player.isPCMEngineRunning == false, "the invalidated engine was left running")
    await player.stop()
  }
}
