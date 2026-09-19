import Foundation
import Testing

@testable import Dash

/// `PCMFramer` is the one piece of the capture path with no hardware
/// dependency: it turns arbitrary-sized byte pushes (whatever
/// `AVAudioConverter` happens to hand back per tap callback) into exact
/// 100 ms/3 200-byte PCM16 16 kHz mono frames for the voice-mode transport.
/// Everything else in `AudioCaptureService` needs a microphone (device only,
/// see `QA_CHECKLIST.md`) — this suite is what actually exercises the framing
/// logic under test.
@Suite("PCM framer")
struct PCMFramerTests {
  @Test("a single push of exactly one frame's worth of bytes yields one frame")
  func exactSingleFrame() {
    var framer = PCMFramer(bytesPerFrame: 3_200)
    let frames = framer.push(Data(repeating: 1, count: 3_200))
    #expect(frames.count == 1)
    #expect(frames[0].count == 3_200)
  }

  @Test("pushes smaller than a frame accumulate until a frame is complete")
  func accumulatesAcrossPushes() {
    var framer = PCMFramer(bytesPerFrame: 3_200)
    // A 1-byte push should not itself complete a frame.
    #expect(framer.push(Data(repeating: 0xAA, count: 1)).isEmpty)
    let frames = framer.push(Data(repeating: 0xBB, count: 3_199))
    #expect(frames.count == 1)
    #expect(frames[0].count == 3_200)
  }

  @Test("a push larger than several frames emits every complete frame and keeps the remainder")
  func largePushEmitsMultipleFrames() {
    var framer = PCMFramer(bytesPerFrame: 3_200)
    // 7000 bytes = two complete 3 200-byte frames plus a 600-byte remainder.
    let frames = framer.push(Data(repeating: 0xCC, count: 7_000))
    #expect(frames.count == 2)
    #expect(frames.allSatisfy { $0.count == 3_200 })

    let tail = framer.drain()
    #expect(tail?.count == 600)
  }

  @Test("frames stay exactly 3 200 bytes across an arbitrary sequence of odd-sized pushes")
  func arbitraryPushSizesStillYieldExactFrames() {
    var framer = PCMFramer(bytesPerFrame: 3_200)
    let pushSizes = [1, 7_000, 5, 3_199, 3_201, 2]
    var allFrames: [Data] = []
    var totalPushed = 0
    for size in pushSizes {
      totalPushed += size
      allFrames.append(contentsOf: framer.push(Data(repeating: UInt8(size % 256), count: size)))
    }
    #expect(allFrames.allSatisfy { $0.count == 3_200 })

    let tail = framer.drain()
    let totalDrained = allFrames.count * 3_200 + (tail?.count ?? 0)
    #expect(totalDrained == totalPushed)
  }

  @Test("draining an empty framer returns nil")
  func drainEmptyReturnsNil() {
    var framer = PCMFramer(bytesPerFrame: 3_200)
    #expect(framer.drain() == nil)
  }

  @Test("drain resets the framer so the next push starts a fresh frame")
  func drainResetsBuffer() {
    var framer = PCMFramer(bytesPerFrame: 3_200)
    _ = framer.push(Data(repeating: 1, count: 100))
    #expect(framer.drain()?.count == 100)
    // The 100 leftover bytes must not still be sitting in the buffer: a fresh
    // 3 200-byte push should complete exactly one frame, not carry them over.
    let frames = framer.push(Data(repeating: 2, count: 3_200))
    #expect(frames.count == 1)
    #expect(frames[0].count == 3_200)
    #expect(framer.drain() == nil)
  }

  @Test("default bytesPerFrame is 3 200 — 100 ms of 16 kHz mono PCM16")
  func defaultFrameSizeIs3200Bytes() {
    var framer = PCMFramer()
    let frames = framer.push(Data(repeating: 0, count: 3_200))
    #expect(frames.count == 1)
    #expect(frames[0].count == 3_200)
  }

  /// Fix round 2 (item 8): `arbitraryPushSizesStillYieldExactFrames` above
  /// only checks total BYTE COUNT, which a byte swapped between two frames
  /// (or dropped and coincidentally replaced) would not necessarily break.
  /// This pushes distinct, non-repeating bytes (a wrapping counter, so no
  /// two bytes in the whole input are equal by coincidence within a
  /// 256-byte window) across the same odd push sizes, then reassembles every
  /// emitted frame plus the drained tail and asserts the result is
  /// byte-for-byte identical to the input — proving ordering and content,
  /// not just length.
  @Test("concatenating every emitted frame plus the drained tail reproduces the input exactly")
  func concatenationReproducesInputExactly() {
    var framer = PCMFramer(bytesPerFrame: 3_200)
    let pushSizes = [1, 7_000, 5, 3_199, 3_201, 2]
    var input = Data()
    var counter: UInt8 = 0
    var allFrames: [Data] = []
    for size in pushSizes {
      var chunk = Data(capacity: size)
      for _ in 0..<size {
        chunk.append(counter)
        counter = counter &+ 1
      }
      input.append(chunk)
      allFrames.append(contentsOf: framer.push(chunk))
    }
    let tail = framer.drain()

    var reassembled = Data()
    for frame in allFrames { reassembled.append(frame) }
    if let tail { reassembled.append(tail) }

    #expect(reassembled == input)
  }
}
