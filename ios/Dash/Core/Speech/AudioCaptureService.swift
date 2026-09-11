@preconcurrency import AVFoundation
import Foundation

/// One voice-mode microphone capture. `Sendable` for the same reason
/// `AudioRecording` is — a `@MainActor` feature (B9) holds it and a fake
/// stands in under test. The simulator has no microphone, so
/// `AudioCaptureService` itself is only exercised on a device; see
/// `QA_CHECKLIST.md`.
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
  /// the stream is dropped without being read to completion — via
  /// `AsyncStream.Continuation.onTermination`. Without this, abandoning the
  /// stream (a view dismissed mid-turn, a cancelled parent task) would leave
  /// the tap installed and the microphone live with nobody listening.
  func start() async throws -> AsyncStream<Data>
  /// Ends capture. A no-op if capture already ended, whether that was this
  /// call, a prior `stop()`, or the stream finishing itself.
  func stop() async
}

enum AudioCaptureError: Error, Equatable, Sendable {
  /// `AVAudioEngine.start()` failed, or no `AVAudioConverter` could be built
  /// for the input hardware format — almost always the audio session was not
  /// activated, or another app holds the input route.
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
/// bytes touches no actor state. So the callback captures the converter and a
/// small thread-safe `FramerBox` directly (both are reference types
/// `@preconcurrency`-imported from AVFoundation, or `@unchecked Sendable` by
/// construction) and only touches the actor to look up `self` for `stop()`.
actor AudioCaptureService: AudioCapturing {
  /// A 0…1 RMS microphone level per frame, for the voice-mode orb — the same
  /// per-consumer, ends-with-the-capture shape as `AudioRecording.level`.
  nonisolated var levels: AsyncStream<Float> { levelBroadcaster.stream }

  private nonisolated let levelBroadcaster = AudioLevelBroadcaster()
  private let engine = AVAudioEngine()
  private var continuation: AsyncStream<Data>.Continuation?
  private var framerBox: FramerBox?
  private var routeObserver: NSObjectProtocol?
  private var interruptionObserver: NSObjectProtocol?
  private var isCapturing = false

  /// The wire format voice mode transports: 16 kHz mono PCM16, interleaved
  /// (there is only one channel, so interleaving is moot, but it is the
  /// format `AVAudioPCMBuffer.int16ChannelData` expects for a flat byte copy).
  static let targetFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true
  )!

  deinit {
    if let routeObserver { NotificationCenter.default.removeObserver(routeObserver) }
    if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
    levelBroadcaster.finish()
  }

  func start() async throws -> AsyncStream<Data> {
    guard !isCapturing else { throw AudioCaptureError.alreadyCapturing }

    try SpeechAudioSession.activateVoiceChat()

    let input = engine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)
    guard let converter = AVAudioConverter(from: inputFormat, to: Self.targetFormat) else {
      throw AudioCaptureError.couldNotStart
    }

    let framerBox = FramerBox()
    let levelBroadcaster = levelBroadcaster
    let (stream, continuation) = AsyncStream<Data>.makeStream(of: Data.self)

    // Fix round 1 (concern 3): fires on EITHER termination case — `.finished`
    // (this actor's own `finishCapture()` calling `continuation.finish()`,
    // in which case `stop()` below is a harmless no-op since `isCapturing`
    // is already false) or `.cancelled` (the consumer's task walking away
    // without anyone calling `stop()`, which is the case this exists for).
    // `Task { await self?.stop() }` is fire-and-forget on purpose:
    // `onTermination`'s closure is synchronous and non-isolated, so it
    // cannot await the actor directly.
    continuation.onTermination = { [weak self] _ in
      Task { await self?.stop() }
    }

    input.installTap(onBus: 0, bufferSize: 1_600, format: inputFormat) { buffer, _ in
      guard let pcmData = Self.convert(buffer: buffer, using: converter) else { return }
      for frame in framerBox.push(pcmData) {
        continuation.yield(frame)
      }
      levelBroadcaster.yield(Self.rms(of: pcmData))
    }

    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      throw AudioCaptureError.couldNotStart
    }

    self.continuation = continuation
    self.framerBox = framerBox
    isCapturing = true
    observeInterruptions()

    return stream
  }

  func stop() async {
    await finishCapture()
  }

  /// Shared by `stop()` and the interruption/route-change observers — either
  /// way capture ends the same way: tear down the engine, hand the framer's
  /// tail to the stream, and finish it.
  private func finishCapture() async {
    guard isCapturing else { return }
    isCapturing = false

    engine.inputNode.removeTap(onBus: 0)
    engine.stop()

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
  }

  private func observeInterruptions() {
    let center = NotificationCenter.default
    routeObserver = center.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil
    ) { [weak self] notification in
      guard
        let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
        AVAudioSession.RouteChangeReason(rawValue: rawReason) == .oldDeviceUnavailable
      else { return }
      Task { await self?.finishCapture() }
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
      Task { await self?.finishCapture() }
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
      for sample in raw.bindMemory(to: Int16.self) {
        let normalized = Double(sample) / Double(Int16.max)
        sumSquares += normalized * normalized
      }
    }
    return Float(min(1, (sumSquares / Double(sampleCount)).squareRoot()))
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
