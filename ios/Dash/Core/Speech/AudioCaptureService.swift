@preconcurrency import AVFoundation
import Foundation

/// One voice-mode microphone capture. `Sendable` for the same reason
/// `AudioRecording` is — a `@MainActor` feature (B9) holds it and a fake
/// stands in under test. The simulator has no microphone, so the REAL tap
/// (the `installTap` default on `AudioCaptureService`'s initializer) is only
/// exercised on a device; see `QA_CHECKLIST.md`. `AudioCaptureService`'s own
/// logic — conversion, framing, termination, generation-guarded teardown —
/// IS exercised off-device via that seam; see `AudioCaptureServiceTests`.
///
/// The service owns its own audio session activation (`SpeechAudioSession
/// .activateVoiceChat()`, unlike dictation's `AudioRecording` where the
/// caller activates) because voice mode's session — mic and speaker running
/// together with echo cancellation — has to be live before the first tap
/// buffer can be converted, and `start()` is the one place that knows that.
protocol AudioCapturing: Sendable {
  /// Starts the microphone tap and returns a stream of 100 ms, 16 kHz mono
  /// PCM16 frames. The stream FINISHES — rather than throwing — when `stop()`
  /// is called, or on its own when an audio-session interruption BEGINS
  /// (e.g. a call arriving; the matching `.ended` is ignored, since by then
  /// this capture is already over) or a route change removes the input
  /// device (`.oldDeviceUnavailable`, e.g. unplugging the active headset —
  /// a NEW device becoming available does not stop capture). Either way the
  /// feature treats a finished stream as "capture stopped"; there is no
  /// separate "interrupted" error to catch.
  ///
  /// Fix round 1 (concern 3): the stream also calls `stop()` on its own if
  /// the CONSUMER walks away — the `for await` loop's task is cancelled, or
  /// the returned stream is never even assigned to a variable and simply
  /// goes out of scope, discarding the caller's only reference to it — via
  /// `AsyncStream.Continuation.onTermination`. That "never referenced at
  /// all" case is not hypothetical: it is EXACTLY as fatal to a caller that
  /// merely forgets to hold the result as an explicit `stop()` would be, and
  /// `AudioCaptureServiceTests` had to learn this the hard way (see the
  /// fix-round-2 report) — a discarded `AsyncStream` deallocates its
  /// underlying storage almost immediately, firing `onTermination` well
  /// before an explicit `stop()` a few lines later would run. Without this
  /// whole mechanism, abandoning the stream (a view dismissed mid-turn, a
  /// cancelled parent task) would leave the tap installed and the
  /// microphone live with nobody listening.
  func start() async throws -> AsyncStream<Data>
  /// Ends capture. A no-op if capture already ended, whether that was this
  /// call, a prior `stop()`, or the stream finishing itself.
  func stop() async
}

enum AudioCaptureError: Error, Equatable, Sendable {
  /// The tap could not be installed — `AVAudioEngine.start()` failed inside
  /// `installTap`, almost always because the audio session was not activated
  /// or another app holds the input route.
  case couldNotStart
  /// `start()` while capture is already running. Mirrors
  /// `AudioRecorderError.alreadyRecording`: stop first rather than silently
  /// orphaning the first tap and its stream.
  case alreadyCapturing
}

/// Captures the microphone via `AVAudioEngine`, converts each tap buffer to
/// 16 kHz mono PCM16 with `AVAudioConverter`, and slices the result into
/// exact 100 ms frames with `PCMFramer`.
///
/// An actor because `AVAudioEngine` is not `Sendable`, but the tap callback
/// itself runs on a realtime audio thread OUTSIDE actor isolation — hopping
/// onto the actor for every buffer would add scheduling latency to the
/// realtime path for no benefit, since converting a buffer and framing its
/// bytes touches no actor state. So the callback captures the converter box
/// and a small thread-safe `FramerBox` directly (both are reference types
/// `@preconcurrency`-imported from AVFoundation, or `@unchecked Sendable` by
/// construction) and only touches the actor to look up `self` for `stop()`.
///
/// Fix round 2 (item 5): the microphone tap itself is behind an injectable
/// seam, `installTap`, so this actor's own logic — conversion, framing,
/// termination plumbing, the generation guard (item 2) — can be exercised
/// against the REAL actor in `AudioCaptureServiceTests` with a fake tap,
/// rather than only against a hand-copied pattern mirror. The default
/// `installTap` (and `activateSession`) are what a real capture uses; they
/// are self-contained static/global values (a default parameter expression
/// cannot reference `self`), which is why the real tap owns its OWN
/// `AVAudioEngine` rather than reusing an instance property — the actor no
/// longer keeps one at all.
actor AudioCaptureService: AudioCapturing {
  /// A 0…1 RMS microphone level per frame, for the voice-mode orb — the same
  /// per-consumer, ends-with-the-capture shape as `AudioRecording.level`.
  nonisolated var levels: AsyncStream<Float> { levelBroadcaster.stream }

  private nonisolated let levelBroadcaster = AudioLevelBroadcaster()
  private let activateSession: @Sendable () throws -> Void
  private let installTap:
    @Sendable (@escaping @Sendable (AVAudioPCMBuffer) -> Void) throws -> @Sendable () -> Void

  private var continuation: AsyncStream<Data>.Continuation?
  private var framerBox: FramerBox?
  private var teardownTap: (@Sendable () -> Void)?
  private var routeObserver: NSObjectProtocol?
  private var interruptionObserver: NSObjectProtocol?
  private var isCapturing = false

  /// Fix round 2 (item 2, BLOCKER): incremented on every `start()`. Every
  /// teardown closure created inside `start()` — `onTermination`, the route-
  /// change observer, the interruption observer — captures the generation it
  /// was born into and routes through `finishCapture(ifGeneration:)`, which
  /// no-ops if a NEWER capture is already running by the time that closure
  /// actually fires. Without this, a stale teardown Task (scheduled while
  /// generation N was capturing, but only actually running on the actor
  /// after generation N+1 has already started — `Task { }` is fire-and-
  /// forget with no ordering guarantee against a synchronous `stop()` +
  /// `start()` in between) would tear down a capture B9 already restarted.
  private var captureGeneration = 0

  /// The wire format voice mode transports: 16 kHz mono PCM16, interleaved
  /// (there is only one channel, so interleaving is moot, but it is the
  /// format `AVAudioPCMBuffer.int16ChannelData` expects for a flat byte copy).
  static let targetFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true
  )!

  init(
    activateSession: @escaping @Sendable () throws -> Void = SpeechAudioSession.activateVoiceChat,
    installTap: @escaping @Sendable (@escaping @Sendable (AVAudioPCMBuffer) -> Void) throws ->
      @Sendable () -> Void = AudioCaptureService.installRealTap
  ) {
    self.activateSession = activateSession
    self.installTap = installTap
  }

  deinit {
    // Explicit hygiene, not a correctness fix: if the actor is deallocated
    // while still capturing (`stop()` never called), the real tap's own
    // `AVAudioEngine` would be torn down anyway once ARC releases it — but
    // calling the teardown closure directly here removes the tap
    // deterministically rather than relying on that side effect.
    teardownTap?()
    if let routeObserver { NotificationCenter.default.removeObserver(routeObserver) }
    if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
    levelBroadcaster.finish()
  }

  func start() async throws -> AsyncStream<Data> {
    guard !isCapturing else { throw AudioCaptureError.alreadyCapturing }

    try activateSession()

    captureGeneration += 1
    let generation = captureGeneration

    let framerBox = FramerBox()
    let converterBox = ConverterBox()
    let levelBroadcaster = levelBroadcaster
    let (stream, continuation) = AsyncStream<Data>.makeStream(of: Data.self)

    // Fix round 1 (concern 3): fires on EITHER termination case — `.finished`
    // (this actor's own `finishCapture()` calling `continuation.finish()`,
    // in which case the guarded `finishCapture` below is a harmless no-op
    // since `isCapturing` is already false) or `.cancelled` (the consumer's
    // task walking away without anyone calling `stop()`, which is the case
    // this exists for). `Task { await ... }` is fire-and-forget on purpose:
    // `onTermination`'s closure is synchronous and non-isolated, so it
    // cannot await the actor directly — which is exactly why this needs the
    // generation guard (item 2 above).
    continuation.onTermination = { [weak self] _ in
      Task { await self?.finishCapture(ifGeneration: generation) }
    }

    let teardown: @Sendable () -> Void
    do {
      teardown = try installTap { buffer in
        guard let converter = converterBox.converter(for: buffer.format) else { return }
        guard let pcmData = Self.convert(buffer: buffer, using: converter) else { return }
        for frame in framerBox.push(pcmData) {
          continuation.yield(frame)
        }
        levelBroadcaster.yield(Self.rms(of: pcmData))
      }
    } catch {
      throw AudioCaptureError.couldNotStart
    }

    self.continuation = continuation
    self.framerBox = framerBox
    self.teardownTap = teardown
    isCapturing = true
    observeInterruptions(generation: generation)

    return stream
  }

  func stop() async {
    await finishCapture()
  }

  /// Fix round 2 (item 2): internal, not `private` — `AudioCaptureServiceTests`
  /// calls this directly to simulate a stale teardown signal deterministically
  /// (finish → restart → fire the OLD generation's closure) rather than
  /// racing real `Task` scheduling to try to reproduce it.
  func finishCapture(ifGeneration generation: Int) async {
    guard generation == captureGeneration else { return }
    await finishCapture()
  }

  /// Fix round 2 (item 2): internal, not `private`, purely so
  /// `AudioCaptureServiceTests` can read the current generation rather than
  /// hardcode "the first capture is generation 1" as an implementation-detail
  /// assumption.
  var captureGenerationForTesting: Int { captureGeneration }

  /// Shared by `stop()` and the interruption/route-change/termination paths
  /// — either way capture ends the same way: tear down the tap, hand the
  /// framer's tail to the stream, and finish it.
  private func finishCapture() async {
    guard isCapturing else { return }
    isCapturing = false

    // Fix round 2 (item 9): the tap callback runs on a realtime audio thread
    // with no synchronization barrier against this actor. `teardownTap()`
    // stops FUTURE callbacks, but one that was already in flight when it is
    // called can still land in `framerBox.push(...)` concurrently with (or
    // immediately after) the `drain()` below. If that in-flight push happens
    // to complete a frame, that frame is dropped by design — there is no
    // "reopen the finished stream to deliver one more frame" — rather than
    // engineered around, since the amount of audio in flight is at most one
    // tap buffer (well under 100 ms) and voice mode already tolerates
    // capture ending at an arbitrary point mid-utterance.
    teardownTap?()
    teardownTap = nil

    if let routeObserver {
      NotificationCenter.default.removeObserver(routeObserver)
      self.routeObserver = nil
    }
    if let interruptionObserver {
      NotificationCenter.default.removeObserver(interruptionObserver)
      self.interruptionObserver = nil
    }

    if let tail = framerBox?.drain() {
      continuation?.yield(tail)
    }
    continuation?.finish()
    continuation = nil
    framerBox = nil
    levelBroadcaster.yield(0)
    // Fix round 2 (item 3, IMPORTANT): ends every live `levels` consumer's
    // loop, mirroring `AudioRecorderService.endMeter()` — without this the
    // orb's meter `for await` never completes even though capture is over.
    // A later `start()` still gets a fresh `levels` stream: the `stream`
    // computed property on `AudioLevelBroadcaster` registers a brand new
    // continuation per access, so finishing here does not poison future
    // consumers, only ones already listening to this capture.
    levelBroadcaster.finish()
  }

  private func observeInterruptions(generation: Int) {
    let center = NotificationCenter.default
    routeObserver = center.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil
    ) { [weak self] notification in
      guard
        let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
        AVAudioSession.RouteChangeReason(rawValue: rawReason) == .oldDeviceUnavailable
      else { return }
      Task { await self?.finishCapture(ifGeneration: generation) }
    }
    // Only `.began` ends capture — a call arriving, another app taking the
    // session. `.ended` is the SAME notification firing again once the
    // interruption is over; reacting to it here would tear down a capture
    // B9 already restarted in response to the `.began` finish.
    interruptionObserver = center.addObserver(
      forName: AVAudioSession.interruptionNotification, object: nil, queue: nil
    ) { [weak self] notification in
      guard
        let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
        AVAudioSession.InterruptionType(rawValue: rawType) == .began
      else { return }
      Task { await self?.finishCapture(ifGeneration: generation) }
    }
  }

  /// Converts one tap buffer (in the hardware's input format) to
  /// `targetFormat` and copies the result out as `Data`. `nil` on a
  /// conversion error or an empty result, in which case the buffer is
  /// dropped rather than surfaced — a single bad buffer should not tear down
  /// the whole capture.
  ///
  /// `nonisolated static` and free of actor state so it can run directly on
  /// the realtime tap thread.
  private nonisolated static func convert(
    buffer inputBuffer: AVAudioPCMBuffer, using converter: AVAudioConverter
  ) -> Data? {
    let ratio = targetFormat.sampleRate / max(inputBuffer.format.sampleRate, 1)
    let capacity = AVAudioFrameCount(Double(inputBuffer.frameLength) * ratio) + 16
    guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity)
    else { return nil }

    // `AVAudioConverter.convert(to:error:withInputFrom:)` calls this block
    // synchronously, on the same thread, one or more times before returning —
    // never actually concurrently — but its block type is annotated in a way
    // that makes the strict-concurrency checker treat captures as if they
    // could race. `nonisolated(unsafe)` opts this single flag out of that
    // check rather than papering over it with a lock nothing needs.
    nonisolated(unsafe) var suppliedInput = false
    var conversionError: NSError?
    let status = converter.convert(to: outputBuffer, error: &conversionError) { _, outStatus in
      if suppliedInput {
        outStatus.pointee = .noDataNow
        return nil
      }
      suppliedInput = true
      outStatus.pointee = .haveData
      return inputBuffer
    }

    guard
      status != .error,
      outputBuffer.frameLength > 0,
      let channelData = outputBuffer.int16ChannelData
    else { return nil }

    let byteCount = Int(outputBuffer.frameLength) * MemoryLayout<Int16>.size
    return Data(bytes: UnsafeRawPointer(channelData[0]), count: byteCount)
  }

  /// A linear 0…1 amplitude for the orb meter, mirroring
  /// `AudioRecorderService.normalizedLevel(fromDecibels:)`'s intent but
  /// computed directly from PCM16 samples rather than `AVAudioRecorder`'s
  /// metering API, since capture has no recorder to ask.
  private nonisolated static func rms(of pcmData: Data) -> Float {
    let sampleCount = pcmData.count / MemoryLayout<Int16>.size
    guard sampleCount > 0 else { return 0 }

    var sumSquares: Double = 0
    pcmData.withUnsafeBytes { raw in
      for index in 0..<sampleCount {
        // Fix round 2 (item 7): `loadUnaligned`, not `bindMemory` — this
        // `Data` is a copy made in `convert(buffer:using:)` above, but
        // nothing about `Data`'s contract guarantees 2-byte alignment for
        // that copy, so reading unaligned is the correct assumption to make.
        let sample = raw.loadUnaligned(fromByteOffset: index * MemoryLayout<Int16>.size, as: Int16.self)
        let normalized = Double(Int16(littleEndian: sample)) / Double(Int16.max)
        sumSquares += normalized * normalized
      }
    }
    return Float(min(1, (sumSquares / Double(sampleCount)).squareRoot()))
  }

  /// The real `installTap`: a self-contained `AVAudioEngine` tap on the
  /// microphone input. Self-contained (rather than an instance property)
  /// because a default parameter expression cannot reference `self` — a
  /// fresh engine per capture, released when the returned teardown closure
  /// is (which happens in `finishCapture()`).
  private static func installRealTap(
    _ handler: @escaping @Sendable (AVAudioPCMBuffer) -> Void
  ) throws -> @Sendable () -> Void {
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)
    input.installTap(onBus: 0, bufferSize: 1_600, format: inputFormat) { buffer, _ in
      handler(buffer)
    }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      throw error
    }
    return {
      input.removeTap(onBus: 0)
      engine.stop()
    }
  }
}

/// A thread-safe box around `PCMFramer`: the realtime tap callback pushes
/// into it from the audio thread, and the actor's `finishCapture()` drains
/// its tail when capture ends — two different isolation domains sharing one
/// mutable buffer, so `PCMFramer` itself can stay a plain, lock-free struct.
private final class FramerBox: @unchecked Sendable {
  private let lock = NSLock()
  private var framer = PCMFramer()

  func push(_ bytes: Data) -> [Data] {
    lock.withLock { framer.push(bytes) }
  }

  func drain() -> Data? {
    lock.withLock { framer.drain() }
  }
}

/// A thread-safe, lazily-built `AVAudioConverter` cache, keyed on the input
/// format's sample rate. Fix round 2 (item 5): with the tap behind the
/// `installTap` seam, the actor no longer has a synchronous look at the
/// hardware's input format before installing the tap (the seam's handler
/// only ever sees `AVAudioPCMBuffer`s, each carrying its own `.format`), so
/// the converter is built from the FIRST buffer's format instead of
/// upfront — and cached, since the format does not change mid-capture in
/// practice. Keyed on `sampleRate` alone (not full `AVAudioFormat` equality)
/// as a pragmatic cache key: channel count/commonFormat do not vary for a
/// mono microphone tap.
private final class ConverterBox: @unchecked Sendable {
  private let lock = NSLock()
  private var cachedSampleRate: Double?
  private var cachedConverter: AVAudioConverter?

  func converter(for format: AVAudioFormat) -> AVAudioConverter? {
    lock.withLock {
      if let cachedSampleRate, let cachedConverter, cachedSampleRate == format.sampleRate {
        return cachedConverter
      }
      guard let converter = AVAudioConverter(from: format, to: AudioCaptureService.targetFormat)
      else { return nil }
      self.cachedSampleRate = format.sampleRate
      self.cachedConverter = converter
      return converter
    }
  }
}
