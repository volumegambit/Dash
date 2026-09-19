@preconcurrency import AVFoundation
import Foundation

/// One dictation recording. `Sendable` so a `@MainActor` feature can hold it
/// and a fake can stand in for it under test — the simulator has no
/// microphone, so `AudioRecorderService` itself is only exercised on a device
/// (A8 covers the feature through a fake).
///
/// The caller owns the audio session: `SpeechAudioSession.activateRecording()`
/// before `start`, `deactivate()` after `stop`/`cancel`.
protocol AudioRecording: Sendable {
  /// `maxDuration` is a hard backstop inside the recorder as well as the cap
  /// the UI counts down; see `DictationState.maxDuration`.
  func start(maxDuration: Duration) async throws
  /// Stops, reads the finished clip and deletes the temp file. The bytes are
  /// AAC in an MPEG-4 container (`.m4a`), which is what
  /// `TranscriptionRequestDTO(format: .m4a)` promises the gateway.
  func stop() async throws -> Data
  /// Stops and deletes without reading — the audio is discarded.
  func cancel() async
  /// A 0…1 microphone level, sampled every 100 ms while recording, for the
  /// composer's meter.
  ///
  /// EVERY ACCESS RETURNS AN INDEPENDENT STREAM, and each one ENDS (the
  /// `for await` completes) when the recording does, on `stop` or `cancel`.
  /// Take a fresh stream per recording; abandoning or cancelling one consumer
  /// affects only that consumer, never the meter for the next recording.
  ///
  /// The independence matters: an `AsyncStream` is dead once its consumer's
  /// task is cancelled, so a single shared stream created with the recorder
  /// would silently stop metering for the rest of the app's life the first
  /// time a dictation task was cancelled.
  var level: AsyncStream<Float> { get }
}

enum AudioRecorderError: Error, Equatable, Sendable {
  /// `AVAudioRecorder.record()` refused — almost always the audio session was
  /// not activated, or another app holds the input route.
  case couldNotStart
  /// `start()` while a recording is already running. Stop or cancel first;
  /// starting silently over the top would orphan the first temp file.
  case alreadyRecording
  /// `stop()` without a `start()`.
  case notRecording
}

/// Fans the meter out to every live `level` consumer, and lets a consumer go
/// away (task cancelled, view dismissed) without taking the others with it.
///
/// A plain final class with an `NSLock` rather than an actor, following
/// `QRScannerRuntime` and `UITestIdentifierSource`: `AudioRecording.level` is
/// a synchronous requirement, so handing out a stream cannot `await`.
final class AudioLevelBroadcaster: @unchecked Sendable {
  private let lock = NSLock()
  private var continuations: [UUID: AsyncStream<Float>.Continuation] = [:]

  /// A fresh stream, registered until it ends — whether that is this
  /// broadcaster finishing it or the consumer walking away.
  var stream: AsyncStream<Float> {
    let id = UUID()
    // `bufferingNewest(1)`: a meter that fell behind should jump to the
    // current loudness, not replay a backlog of stale samples.
    let pair = AsyncStream<Float>.makeStream(of: Float.self, bufferingPolicy: .bufferingNewest(1))
    pair.continuation.onTermination = { [weak self] _ in
      self?.remove(id)
    }
    lock.withLock { continuations[id] = pair.continuation }
    return pair.stream
  }

  func yield(_ value: Float) {
    // Copied out from under the lock: `yield` can run the consumer's
    // termination handler, which comes straight back here for `remove`.
    for continuation in lock.withLock({ Array(continuations.values) }) {
      continuation.yield(value)
    }
  }

  /// Ends every live consumer's loop — the recording is over, so a `for await`
  /// on the meter should complete rather than hang.
  func finish() {
    let live = lock.withLock {
      let values = Array(continuations.values)
      continuations.removeAll()
      return values
    }
    for continuation in live { continuation.finish() }
  }

  /// Live consumer count, for tests.
  var consumerCount: Int { lock.withLock { continuations.count } }

  private func remove(_ id: UUID) {
    _ = lock.withLock { continuations.removeValue(forKey: id) }
  }
}

/// Records dictation to a temp `.m4a` with `AVAudioRecorder`.
///
/// An actor because `AVAudioRecorder` is not `Sendable`: keeping it isolated
/// here is what lets `AudioRecording` be a `Sendable` protocol at all. The
/// heavy `AVAudioEngine` tap the design describes belongs to Phase B's
/// streaming session — dictation only needs a file, and a file recorder is
/// far less to get wrong.
actor AudioRecorderService: AudioRecording {
  nonisolated var level: AsyncStream<Float> { levels.stream }

  private nonisolated let levels = AudioLevelBroadcaster()
  private let clock: any AppClock
  private var recorder: AVAudioRecorder?
  private var fileURL: URL?
  private var meterTask: Task<Void, Never>?

  /// 100 ms: fast enough that the meter reads as live, slow enough that it is
  /// not a per-frame wakeup.
  private static let meterInterval: Duration = .milliseconds(100)

  init(clock: any AppClock = SystemAppClock()) {
    self.clock = clock
  }

  deinit {
    // Only the nonisolated broadcaster is touched here; the meter task holds
    // `self` weakly and exits on its next tick.
    levels.finish()
  }

  func start(maxDuration: Duration) async throws {
    // Starting over a live recording would orphan its temp file and its meter
    // task, so it is an error rather than an implicit cancel — the caller
    // knows whether the audio should be kept (`stop`) or dropped (`cancel`).
    //
    // This method suspends nowhere, so the actor runs it to completion and two
    // callers cannot interleave past this guard.
    guard recorder == nil else { throw AudioRecorderError.alreadyRecording }
    // Clears any residue from a `start` that failed halfway. Deliberately not
    // `cancel()`: that also ends the meter streams, and a caller that took one
    // before starting would find it already closed.
    discardRecording()

    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString)
      .appendingPathExtension("m4a")

    // 16 kHz mono AAC: speech models resample to 16 kHz anyway, and mono at
    // medium quality keeps a 60 s clip far under the gateway's 8 MB body
    // limit even after base64 inflates it by a third.
    let settings: [String: Any] = [
      AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
      AVSampleRateKey: 16_000.0,
      AVNumberOfChannelsKey: 1,
      AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
    ]

    let recorder = try AVAudioRecorder(url: url, settings: settings)
    recorder.isMeteringEnabled = true

    // `record(forDuration:)` rather than a bare `record()`: the reducer's
    // `autoFinish` is a UI timer and stops firing if the app is suspended, so
    // the recorder enforces the cap itself. A clip that hit the backstop is
    // still a complete file — `stop()` reads it either way.
    guard recorder.record(forDuration: Self.seconds(maxDuration)) else {
      // `record()` prepares the file before it fails, so the empty container
      // is already on disk and nothing else will ever remove it.
      try? FileManager.default.removeItem(at: url)
      throw AudioRecorderError.couldNotStart
    }

    self.recorder = recorder
    fileURL = url
    startMetering()
  }

  func stop() async throws -> Data {
    guard let recorder, let url = fileURL else { throw AudioRecorderError.notRecording }
    meterTask?.cancel()
    meterTask = nil
    // Not guarded on `isRecording`: the `forDuration` backstop may already
    // have stopped it, and the file still has to be read and removed.
    recorder.stop()
    self.recorder = nil
    fileURL = nil
    endMeter()
    // The clip is never persisted — the usage string promises exactly that.
    defer { try? FileManager.default.removeItem(at: url) }
    return try Data(contentsOf: url)
  }

  func cancel() async {
    discardRecording()
    endMeter()
  }

  /// Tears the recording down without touching the meter streams.
  private func discardRecording() {
    meterTask?.cancel()
    meterTask = nil
    recorder?.stop()
    recorder = nil
    if let url = fileURL {
      try? FileManager.default.removeItem(at: url)
      fileURL = nil
    }
  }

  /// Drops the meter to silence so a UI still on screen does not freeze with
  /// the last loud sample, then ends every consumer's loop.
  private func endMeter() {
    levels.yield(0)
    levels.finish()
  }

  private func startMetering() {
    meterTask = Task { [weak self, clock] in
      while !Task.isCancelled {
        do {
          try await clock.sleep(for: Self.meterInterval)
        } catch {
          return
        }
        guard let self else { return }
        await self.emitLevel()
      }
    }
  }

  private func emitLevel() {
    guard let recorder else { return }
    // The `forDuration` backstop can stop the recorder before anyone calls
    // `stop()`; report silence rather than leaving the last sample frozen on
    // screen until the caller notices.
    guard recorder.isRecording else {
      levels.yield(0)
      return
    }
    recorder.updateMeters()
    levels.yield(Self.normalizedLevel(fromDecibels: recorder.averagePower(forChannel: 0)))
  }

  /// `averagePower(forChannel:)` is in dBFS: 0 at full scale, −160 for
  /// digital silence. The meter wants a linear 0…1 amplitude, so this is the
  /// inverse of 20·log₁₀(amplitude), with everything below the noise floor
  /// pinned to 0 — otherwise a silent room still shows a visible sliver.
  ///
  /// `nonisolated` and `static` so it is pure, and testable without a
  /// microphone.
  nonisolated static func normalizedLevel(fromDecibels decibels: Float) -> Float {
    guard decibels > silenceFloorDecibels else { return 0 }
    return min(1, pow(10, decibels / 20))
  }

  /// −60 dBFS is quiet-room noise; below it the meter reads as silence.
  private static let silenceFloorDecibels: Float = -60

  private nonisolated static func seconds(_ duration: Duration) -> TimeInterval {
    let components = duration.components
    return TimeInterval(components.seconds) + TimeInterval(components.attoseconds) / 1e18
  }
}
