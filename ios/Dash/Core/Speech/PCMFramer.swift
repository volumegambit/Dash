import Foundation

/// Slices an arbitrary sequence of PCM byte pushes into fixed-size frames.
///
/// `AVAudioConverter` hands `AudioCaptureService` a variable number of bytes
/// per tap callback — whatever the hardware buffer size and sample-rate
/// conversion ratio happen to produce — but the voice-mode transport (B9)
/// wants exact 100 ms frames to send over the wire. This type is the seam
/// between the two: push whatever arrives, get back zero or more
/// frames of exactly `bytesPerFrame` bytes plus whatever remainder isn't a
/// full frame yet.
///
/// A plain struct (no actor, no lock): it is pure buffering logic with no
/// hardware dependency, so it is unit-testable directly, and its one caller
/// (`AudioCaptureService`) already provides the concurrency-safe seam for the
/// realtime audio thread — see `FramerBox` there.
struct PCMFramer {
  private let bytesPerFrame: Int
  private var buffer: [UInt8] = []

  /// 3 200 bytes: 100 ms of 16 kHz mono PCM16 (16 000 samples/sec × 0.1 s ×
  /// 2 bytes/sample).
  init(bytesPerFrame: Int = 3_200) {
    self.bytesPerFrame = bytesPerFrame
  }

  /// Appends `bytes` to the internal buffer and returns every complete
  /// `bytesPerFrame`-sized frame that can now be cut from it, in order.
  /// Leftover bytes short of a full frame stay buffered for the next push
  /// (or `drain()`).
  mutating func push(_ bytes: Data) -> [Data] {
    buffer.append(contentsOf: bytes)

    guard buffer.count >= bytesPerFrame else { return [] }

    var frames: [Data] = []
    var offset = 0
    while buffer.count - offset >= bytesPerFrame {
      frames.append(Data(buffer[offset..<(offset + bytesPerFrame)]))
      offset += bytesPerFrame
    }
    buffer.removeFirst(offset)
    return frames
  }

  /// Returns whatever partial frame is left in the buffer — fewer than
  /// `bytesPerFrame` bytes — and resets so the next `push` starts clean.
  /// `nil` when there is nothing buffered, which is also true right after a
  /// `drain()` (draining twice in a row without an intervening `push` is not
  /// an error, just an empty result).
  mutating func drain() -> Data? {
    guard !buffer.isEmpty else { return nil }
    defer { buffer.removeAll() }
    return Data(buffer)
  }
}
