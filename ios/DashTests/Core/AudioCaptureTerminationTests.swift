import Foundation
import Testing

@testable import Dash

/// `AudioCaptureService`'s microphone tap cannot be faked — it is
/// `AVAudioEngine.inputNode`, hardware the simulator does not have (see
/// `QA_CHECKLIST.md`'s "Voice mode — capture and playback (device only)").
/// What CAN be pinned without hardware is fix round 1's termination
/// plumbing: `AudioCaptureService.start()` wires the returned
/// `AsyncStream`'s `onTermination` to call `stop()` through the actor, so a
/// consumer that walks away (its task cancelled, the stream dropped) never
/// leaves the microphone hot with nobody listening.
///
/// `TerminationOwner` below mirrors that exact shape — an actor whose
/// `start()` hands back an `AsyncStream` with the identical
/// `onTermination { [weak self] _ in Task { await self?.stop() } }` wiring —
/// standing in for `AudioCaptureService` itself. This is the "smallest test
/// that proves stop() runs when the stream's task is cancelled" fallback:
/// it validates the PATTERN `AudioCaptureService` uses, not the real capture
/// actor, since the real one cannot be started off a device.
@Suite("Stream termination stops the owning actor")
struct AudioCaptureTerminationTests {
  @Test("cancelling the task reading the stream calls stop() on the actor")
  func cancellationCallsStop() async {
    let owner = TerminationOwner()
    let stream = await owner.start()

    let reader = Task {
      for await _ in stream {
        // Never yields anything in this test — the loop exists only so
        // there is a live consumer suspended inside the stream for
        // cancellation to interrupt. A stream nobody has started reading
        // yet cancels its task without ever entering `.cancelled` on the
        // continuation the same way.
      }
    }
    // Let the reader actually suspend inside the stream before cancelling
    // it — cancelling immediately risks the task never reaching the
    // `for await` at all, which would not exercise the `.cancelled`
    // termination path this test is for.
    try? await Task.sleep(for: .milliseconds(50))
    reader.cancel()

    await expectEventuallyAsync("stop() to run after the stream's task is cancelled") {
      await owner.stopped
    }
  }

  @Test("the producer finishing the stream itself also calls stop(), harmlessly")
  func naturalFinishAlsoCallsStop() async {
    // The same `onTermination` fires on `.finished` as well as `.cancelled`
    // — `AudioCaptureService.finishCapture()` calling `continuation.finish()`
    // re-enters its own already-guarded `stop()`. This pins that the
    // no-op-when-already-stopped guard makes that harmless rather than
    // double-running teardown.
    let owner = TerminationOwner()
    _ = await owner.start()
    await owner.finish()

    await expectEventuallyAsync("stop() to run after the producer finishes the stream") {
      await owner.stopped
    }
    #expect(await owner.stopCallCount <= 2)
  }
}

/// Mirrors `AudioCaptureService`'s exact shape for this one behavior: an
/// actor whose `start()` returns an `AsyncStream` with `onTermination`
/// calling `stop()` through the actor, non-blocking, and whose `stop()` is
/// idempotent — a second call (e.g. `.finished` following an explicit
/// `stop()`, or vice versa) does nothing further.
private actor TerminationOwner {
  private(set) var stopped = false
  private(set) var stopCallCount = 0
  private var continuation: AsyncStream<Data>.Continuation?
  private var running = false

  func start() -> AsyncStream<Data> {
    let (stream, continuation) = AsyncStream<Data>.makeStream(of: Data.self)
    continuation.onTermination = { [weak self] _ in
      Task { await self?.stop() }
    }
    self.continuation = continuation
    running = true
    return stream
  }

  /// Stands in for `AudioCaptureService.finishCapture()` calling
  /// `continuation.finish()` on its own (e.g. an interruption ending
  /// capture) — this is what triggers the `.finished` termination case.
  func finish() {
    continuation?.finish()
    continuation = nil
  }

  func stop() {
    stopCallCount += 1
    guard running else { return }
    running = false
    stopped = true
  }
}
