import AVFoundation
import Foundation
import Testing

@testable import Dash

/// Fix round 2 (item 5): replaces the earlier `AudioCaptureTerminationTests`,
/// which only tested a hand-copied pattern mirror of `AudioCaptureService`'s
/// termination wiring, not the real actor. `AudioCaptureService`'s
/// initializer now takes an injectable `installTap` seam — the real
/// microphone tap (`AVAudioEngine.inputNode`) is still device-only (see
/// `QA_CHECKLIST.md`), but everything ELSE the actor does — conversion,
/// framing, termination plumbing, the generation guard — is exercised here
/// against the REAL `AudioCaptureService`, with only the tap faked.
///
/// `.serialized`: several tests post real notifications to
/// `NotificationCenter.default` (`AVAudioSession.routeChangeNotification`,
/// `.interruptionNotification`) with `object: nil`, which is process-wide —
/// running these concurrently with each other (or with a future suite doing
/// the same) risks one test's notification reaching another test's live
/// observer.
@Suite("Audio capture service", .serialized)
struct AudioCaptureServiceTests {
  @Test("start() while already capturing throws alreadyCapturing")
  func secondStartThrows() async throws {
    let controller = FakeTapController()
    let service = AudioCaptureService(activateSession: {}, installTap: controller.install)
    // `let stream =`, not `_ =`: discarding the returned `AsyncStream` with
    // `_` drops the only strong reference to it immediately, and per fix
    // round 1's own abandonment fix, an unreferenced stream terminates via
    // `onTermination` on deallocation — which would end this capture before
    // the assertion below ever runs. Binding it to a name keeps it alive for
    // the rest of the test, the same way a real caller holding onto the
    // stream (even before reading from it) would.
    let stream = try await service.start()

    await #expect(throws: AudioCaptureError.alreadyCapturing) {
      try await service.start()
    }
    await service.stop()
    withExtendedLifetime(stream) {}
  }

  @Test("start() propagates activateSession's error")
  func activateSessionErrorPropagates() async {
    let service = AudioCaptureService(
      activateSession: { throw BoomError() },
      installTap: { _ in {} }
    )
    await #expect(throws: BoomError.self) {
      try await service.start()
    }
  }

  @Test("start() throws couldNotStart when installTap fails")
  func installTapFailureThrowsCouldNotStart() async {
    let service = AudioCaptureService(
      activateSession: {},
      installTap: { _ in throw AudioCaptureError.couldNotStart }
    )
    await #expect(throws: AudioCaptureError.couldNotStart) {
      try await service.start()
    }
  }

  @Test("cancelling the stream's reader task stops capture via onTermination")
  func cancellingReaderStopsCapture() async throws {
    let controller = FakeTapController()
    let service = AudioCaptureService(activateSession: {}, installTap: controller.install)
    let stream = try await service.start()

    let reader = Task {
      for await _ in stream {
        // Nothing is pushed in this test; the loop exists only so there is
        // a live consumer for cancellation to interrupt.
      }
    }
    // Let the reader actually suspend inside the stream before cancelling —
    // cancelling immediately risks the task never reaching the `for await`
    // at all, which would not exercise the `.cancelled` termination path.
    try? await Task.sleep(for: .milliseconds(50))
    reader.cancel()

    // Observable only through the public API: a second `start()` still
    // throws `alreadyCapturing` until `onTermination`'s `stop()` actually
    // runs. Once it does, `start()` succeeds instead.
    await expectEventuallyAsync("start() to succeed again once onTermination stops capture") {
      do {
        _ = try await service.start()
        return true
      } catch {
        return false
      }
    }
    await service.stop()
  }

  @Test("a stale teardown signal for an old generation does not tear down a newer capture")
  func staleGenerationIsIgnored() async throws {
    let controller = FakeTapController()
    let service = AudioCaptureService(activateSession: {}, installTap: controller.install)

    _ = try await service.start()
    let staleGeneration = await service.captureGenerationForTesting
    await service.stop()
    // `let stream =`, not `_ =`: see `secondStartThrows`'s comment — an
    // unreferenced `AsyncStream` self-terminates on deallocation, which
    // would end generation 2's capture before this test ever gets to fire
    // the stale signal against it, making the test pass for the wrong
    // reason (or not at all).
    let stream = try await service.start()  // generation 2 is now running

    // Simulates a teardown `Task` that was scheduled while generation 1 was
    // capturing but only actually runs on the actor now — after generation
    // 2 has already started. This is the exact race the generation guard
    // exists for: `Task { }` closures created inside `start()` (onTermination,
    // the interruption/route-change observers) have no ordering guarantee
    // against a synchronous `stop()` + `start()` happening first.
    await service.finishCapture(ifGeneration: staleGeneration)

    // If the guard had failed, that call would have torn generation 2 down,
    // and this second `start()` would succeed instead of throwing.
    await #expect(throws: AudioCaptureError.alreadyCapturing) {
      try await service.start()
    }
    await service.stop()
    withExtendedLifetime(stream) {}
  }

  @Test("the framer's partial tail is yielded when stop() ends capture")
  func tailYieldedOnStop() async throws {
    let controller = FakeTapController()
    let service = AudioCaptureService(activateSession: {}, installTap: controller.install)
    let stream = try await service.start()

    let collector = FrameCollector()
    let completion = Completion()
    Task {
      for await frame in stream { await collector.add(frame) }
      await completion.markDone()
    }

    // Well under one 100 ms/3 200-byte frame's worth, so nothing is yielded
    // by `push` alone — these bytes only reach the stream because `stop()`
    // drains the framer's tail.
    let buffer = makeInputBuffer(frequency: 440, sampleRate: 16_000, sampleCount: 100)
    controller.push(buffer)
    try? await Task.sleep(for: .milliseconds(20))

    await service.stop()
    await expectEventuallyAsync("the reader to finish once stop() ends the stream") {
      await completion.isDone
    }

    let frames = await collector.frames
    #expect(frames.count == 1)
    #expect((frames.first?.count ?? 0) > 0)
    #expect((frames.first?.count ?? 0) < 3_200)
  }

  @Test("pushing enough real audio through the fake tap yields exact 3 200-byte frames")
  func realAudioProducesExactFrames() async throws {
    let controller = FakeTapController()
    let service = AudioCaptureService(activateSession: {}, installTap: controller.install)
    let stream = try await service.start()

    let collector = FrameCollector()
    let reader = Task {
      for await frame in stream { await collector.add(frame) }
    }

    // 500 ms of a real 440 Hz tone at 16 kHz (the sample rate matches
    // `targetFormat`, so the converter is doing format conversion only, not
    // resampling) — comfortably more than one 100 ms frame's worth even
    // allowing for the converter's own internal buffering.
    let buffer = makeInputBuffer(frequency: 440, sampleRate: 16_000, sampleCount: 8_000)
    controller.push(buffer)

    await expectEventuallyAsync("at least one exact frame to arrive") {
      await !collector.frames.isEmpty
    }

    #expect(await collector.frames.first?.count == 3_200)
    await service.stop()
    reader.cancel()
  }

  @Test("the levels stream completes after stop()")
  func levelsStreamCompletesAfterStop() async throws {
    let controller = FakeTapController()
    let service = AudioCaptureService(activateSession: {}, installTap: controller.install)
    // `let stream =`, not `_ =`: see `secondStartThrows`'s comment. Without
    // this, the discarded `Data` stream self-terminates on deallocation and
    // ends capture (and so also finishes `levels`, via the SAME
    // `finishCapture()`) before the explicit `service.stop()` below ever
    // runs — which happened to still finish `levels` in this particular
    // case, but only by accident of ordering, not because of what this test
    // claims to prove (that `stop()` itself finishes `levels`).
    let stream = try await service.start()

    let completion = Completion()
    let levelsReader = Task {
      for await _ in service.levels {}
      await completion.markDone()
    }
    // Spawning a `Task` only SCHEDULES it — there is no guarantee it runs
    // even one line before this function's next statement. Without this
    // sleep, `service.stop()` (and the `levelBroadcaster.finish()` inside
    // it) can run before `levelsReader` ever reaches `service.levels`,
    // registering its consumer with `AudioLevelBroadcaster` too late to be
    // among the ones `finish()` ends — an unrelated race from the one this
    // test is actually about, but one that would hang it regardless.
    try? await Task.sleep(for: .milliseconds(50))

    await service.stop()
    await expectEventuallyAsync("the levels stream to complete after stop()") {
      await completion.isDone
    }
    levelsReader.cancel()
    withExtendedLifetime(stream) {}
  }

  @Test("an audio-session interruption beginning finishes the stream")
  func interruptionBeginFinishesStream() async throws {
    let controller = FakeTapController()
    let service = AudioCaptureService(activateSession: {}, installTap: controller.install)
    let stream = try await service.start()

    let completion = Completion()
    let reader = Task {
      for await _ in stream {}
      await completion.markDone()
    }

    NotificationCenter.default.post(
      name: AVAudioSession.interruptionNotification,
      object: nil,
      userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue]
    )

    await expectEventuallyAsync("the stream to finish after an interruption begins") {
      await completion.isDone
    }
    reader.cancel()
  }

  @Test("an interruption ENDING (without a prior beginning observed here) does not finish the stream")
  func interruptionEndAloneDoesNotFinishStream() async throws {
    let controller = FakeTapController()
    let service = AudioCaptureService(activateSession: {}, installTap: controller.install)
    let stream = try await service.start()

    let completion = Completion()
    let reader = Task {
      for await _ in stream {}
      await completion.markDone()
    }

    NotificationCenter.default.post(
      name: AVAudioSession.interruptionNotification,
      object: nil,
      userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue]
    )

    // Negative assertion: give `.ended` a real chance to (incorrectly) finish
    // the stream, then confirm capture is still running via the public API.
    try? await Task.sleep(for: .milliseconds(100))
    #expect(await completion.isDone == false)
    await #expect(throws: AudioCaptureError.alreadyCapturing) {
      try await service.start()
    }

    await service.stop()
    reader.cancel()
  }

  @Test("a route change to .oldDeviceUnavailable finishes the stream")
  func routeChangeOldDeviceUnavailableFinishesStream() async throws {
    let controller = FakeTapController()
    let service = AudioCaptureService(activateSession: {}, installTap: controller.install)
    let stream = try await service.start()

    let completion = Completion()
    let reader = Task {
      for await _ in stream {}
      await completion.markDone()
    }

    NotificationCenter.default.post(
      name: AVAudioSession.routeChangeNotification,
      object: nil,
      userInfo: [
        AVAudioSessionRouteChangeReasonKey: AVAudioSession.RouteChangeReason.oldDeviceUnavailable
          .rawValue
      ]
    )

    await expectEventuallyAsync("the stream to finish after the active input disconnects") {
      await completion.isDone
    }
    reader.cancel()
  }

  @Test("a route change to .newDeviceAvailable does NOT finish the stream")
  func routeChangeNewDeviceAvailableDoesNotFinishStream() async throws {
    let controller = FakeTapController()
    let service = AudioCaptureService(activateSession: {}, installTap: controller.install)
    let stream = try await service.start()

    let completion = Completion()
    let reader = Task {
      for await _ in stream {}
      await completion.markDone()
    }

    NotificationCenter.default.post(
      name: AVAudioSession.routeChangeNotification,
      object: nil,
      userInfo: [
        AVAudioSessionRouteChangeReasonKey: AVAudioSession.RouteChangeReason.newDeviceAvailable
          .rawValue
      ]
    )

    try? await Task.sleep(for: .milliseconds(100))
    #expect(await completion.isDone == false)
    await #expect(throws: AudioCaptureError.alreadyCapturing) {
      try await service.start()
    }

    await service.stop()
    reader.cancel()
  }

  /// A real, non-silent Float32 mono tone at `sampleRate`, non-interleaved —
  /// the shape `AVAudioConverter` expects on its INPUT side. Real audio
  /// values (not a zero-filled buffer) so the conversion path actually runs
  /// over varying samples.
  private func makeInputBuffer(frequency: Double, sampleRate: Double, sampleCount: Int)
    -> AVAudioPCMBuffer
  {
    let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sampleCount))!
    buffer.frameLength = AVAudioFrameCount(sampleCount)
    guard let channel = buffer.floatChannelData else { fatalError("expected float channel data") }
    for index in 0..<sampleCount {
      let time = Double(index) / sampleRate
      channel[0][index] = Float(sin(2 * Double.pi * frequency * time) * 0.5)
    }
    return buffer
  }
}

private struct BoomError: Error, Equatable {}

/// Stands in for `AudioCaptureService.installRealTap`: records the handler
/// so the test can `push(_:)` buffers into it directly, and the teardown
/// call count, without touching any real `AVAudioEngine`.
private final class FakeTapController: @unchecked Sendable {
  private let lock = NSLock()
  private var handler: (@Sendable (AVAudioPCMBuffer) -> Void)?
  private(set) var teardownCount = 0

  func install(
    _ handler: @escaping @Sendable (AVAudioPCMBuffer) -> Void
  ) throws -> @Sendable () -> Void {
    lock.withLock { self.handler = handler }
    return { [weak self] in
      guard let self else { return }
      self.lock.withLock { self.teardownCount += 1 }
    }
  }

  func push(_ buffer: AVAudioPCMBuffer) {
    let handler = lock.withLock { self.handler }
    handler?(buffer)
  }
}

/// Collects frames off a stream from within a consuming `Task`, actor-boxed
/// since the collecting task and the assertions reading it afterward are in
/// different isolation contexts.
private actor FrameCollector {
  private(set) var frames: [Data] = []

  func add(_ frame: Data) {
    frames.append(frame)
  }
}

/// A single boolean flag a consuming `Task` sets when its `for await` loop
/// ends — the way these tests observe "the stream finished" from outside the
/// task itself.
private actor Completion {
  private(set) var isDone = false

  func markDone() {
    isDone = true
  }
}
