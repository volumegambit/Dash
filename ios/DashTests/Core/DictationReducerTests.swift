import Foundation
import Testing

@testable import Dash

@Suite("Dictation reducer")
struct DictationReducerTests {
  @Test("started begins a recording at zero elapsed and zero level")
  func startedBeginsRecording() {
    var state = DictationState()
    let effect = DictationReducer.reduce(state: &state, action: .started)

    #expect(state.phase == .recording(elapsed: .zero, level: 0))
    #expect(effect == nil)
  }

  @Test("started clears a previous failure — the retry button re-records rather than reset first")
  func startedClearsAFailure() {
    var state = DictationState(phase: .failed("Nothing was heard."))
    let effect = DictationReducer.reduce(state: &state, action: .started)

    #expect(state.phase == .recording(elapsed: .zero, level: 0))
    #expect(effect == nil)
  }

  @Test(
    "started from a live recording or an in-flight upload re-arms at zero — A8 must cancel the work it abandons"
  )
  func startedFromRecordingOrUploadingReArms() {
    let phases: [DictationState.Phase] = [.recording(elapsed: .seconds(9), level: 0.8), .uploading]

    for phase in phases {
      var state = DictationState(phase: phase)
      let effect = DictationReducer.reduce(state: &state, action: .started)

      #expect(state.phase == .recording(elapsed: .zero, level: 0))
      #expect(effect == nil)
    }
  }

  @Test("tick carries the elapsed time and the meter level into the recording phase")
  func tickUpdatesElapsedAndLevel() {
    var state = DictationState(phase: .recording(elapsed: .zero, level: 0))
    let effect = DictationReducer.reduce(
      state: &state,
      action: .tick(elapsed: .milliseconds(1500), level: 0.42)
    )

    #expect(state.phase == .recording(elapsed: .milliseconds(1500), level: 0.42))
    #expect(effect == nil)
  }

  @Test("a tick just under the 60 s cap does not auto-finish")
  func tickBelowTheCapDoesNotAutoFinish() {
    var state = DictationState(phase: .recording(elapsed: .milliseconds(59_800), level: 0.1))
    let effect = DictationReducer.reduce(
      state: &state,
      action: .tick(elapsed: .milliseconds(59_900), level: 0.2)
    )

    #expect(state.phase == .recording(elapsed: .milliseconds(59_900), level: 0.2))
    #expect(effect == nil)
  }

  @Test("the tick that reaches exactly 60.0 s auto-finishes, and later ticks do not repeat it")
  func tickAtTheCapAutoFinishesExactlyOnce() {
    var state = DictationState(phase: .recording(elapsed: .milliseconds(59_900), level: 0.2))

    let atCap = DictationReducer.reduce(
      state: &state,
      action: .tick(elapsed: .seconds(60), level: 0.3)
    )
    #expect(atCap == .autoFinish)
    #expect(state.phase == .recording(elapsed: .seconds(60), level: 0.3))

    let past = DictationReducer.reduce(
      state: &state,
      action: .tick(elapsed: .milliseconds(60_100), level: 0.4)
    )
    #expect(past == nil)
    #expect(state.phase == .recording(elapsed: .seconds(60), level: 0.4))
  }

  @Test("a tick that jumps past the cap auto-finishes once and clamps the countdown at 60 s")
  func tickJumpingPastTheCapFiresOnceAndClamps() {
    var state = DictationState(phase: .recording(elapsed: .milliseconds(59_900), level: 0.2))

    let jump = DictationReducer.reduce(
      state: &state,
      action: .tick(elapsed: .milliseconds(61_000), level: 0.5)
    )
    #expect(jump == .autoFinish)
    #expect(state.phase == .recording(elapsed: .seconds(60), level: 0.5))

    let again = DictationReducer.reduce(
      state: &state,
      action: .tick(elapsed: .milliseconds(62_000), level: 0.5)
    )
    #expect(again == nil)
  }

  @Test("a tick outside the recording phase is ignored — a late meter sample cannot resurrect it")
  func tickOutsideRecordingIsIgnored() {
    for phase in [DictationState.Phase.idle, .uploading, .failed("boom")] {
      var state = DictationState(phase: phase)
      let effect = DictationReducer.reduce(
        state: &state,
        action: .tick(elapsed: .seconds(90), level: 0.9)
      )

      #expect(state.phase == phase)
      #expect(effect == nil)
    }
  }

  @Test("finished moves a recording to uploading")
  func finishedMovesToUploading() {
    var state = DictationState(phase: .recording(elapsed: .seconds(3), level: 0.5))
    let effect = DictationReducer.reduce(state: &state, action: .finished)

    #expect(state.phase == .uploading)
    #expect(effect == nil)
  }

  @Test("finished outside the recording phase is ignored — the auto-finish and the tap can race")
  func finishedOutsideRecordingIsIgnored() {
    for phase in [DictationState.Phase.idle, .uploading, .failed("boom")] {
      var state = DictationState(phase: phase)
      let effect = DictationReducer.reduce(state: &state, action: .finished)

      #expect(state.phase == phase)
      #expect(effect == nil)
    }
  }

  @Test("transcribed inserts the text and returns to idle")
  func transcribedInsertsAndResets() {
    var state = DictationState(phase: .uploading)
    let effect = DictationReducer.reduce(state: &state, action: .transcribed("hello world"))

    #expect(state.phase == .idle)
    #expect(effect == .insert("hello world"))
  }

  @Test("a transcript that lands after a cancel is dropped — discarded audio must not reach the draft")
  func transcribedAfterCancelIsDropped() {
    var state = DictationState(phase: .uploading)
    _ = DictationReducer.reduce(state: &state, action: .cancelled)

    let effect = DictationReducer.reduce(state: &state, action: .transcribed("hello world"))

    #expect(state.phase == .idle)
    #expect(effect == nil)
  }

  @Test("a transcript that arrives while recording, or after the upload already failed, is dropped")
  func transcribedOutsideUploadingIsDropped() {
    let phases: [DictationState.Phase] = [
      .recording(elapsed: .seconds(2), level: 0.4),
      .failed("The request timed out."),
    ]

    for phase in phases {
      var state = DictationState(phase: phase)
      let effect = DictationReducer.reduce(state: &state, action: .transcribed("late text"))

      #expect(state.phase == phase)
      #expect(effect == nil)
    }
  }

  @Test("failed records the message from any phase, including idle (permission denied)")
  func failedRecordsTheMessageFromAnyPhase() {
    let phases: [DictationState.Phase] = [
      .idle,
      .recording(elapsed: .seconds(2), level: 0.3),
      .uploading,
      .failed("older"),
    ]

    for phase in phases {
      var state = DictationState(phase: phase)
      let effect = DictationReducer.reduce(state: &state, action: .failed("Microphone access is off."))

      #expect(state.phase == .failed("Microphone access is off."))
      #expect(effect == nil)
    }
  }

  @Test("a failure survives ticks and finishes, and only reset clears it")
  func failureIsKeptUntilReset() {
    var state = DictationState(phase: .uploading)
    _ = DictationReducer.reduce(state: &state, action: .failed("Transcription failed."))

    _ = DictationReducer.reduce(state: &state, action: .tick(elapsed: .seconds(1), level: 0.5))
    _ = DictationReducer.reduce(state: &state, action: .finished)
    #expect(state.phase == .failed("Transcription failed."))

    let effect = DictationReducer.reduce(state: &state, action: .reset)
    #expect(state.phase == .idle)
    #expect(effect == nil)
  }

  @Test("reset outside a failure is a no-op — it must not strand a live recorder")
  func resetOutsideAFailureIsIgnored() {
    let phases: [DictationState.Phase] = [
      .idle,
      .recording(elapsed: .seconds(2), level: 0.3),
      .uploading,
    ]

    for phase in phases {
      var state = DictationState(phase: phase)
      let effect = DictationReducer.reduce(state: &state, action: .reset)

      #expect(state.phase == phase)
      #expect(effect == nil)
    }
  }

  @Test("cancelled returns to idle from every phase")
  func cancelledReturnsToIdleFromEveryPhase() {
    let phases: [DictationState.Phase] = [
      .idle,
      .recording(elapsed: .seconds(12), level: 0.7),
      .uploading,
      .failed("Transcription failed."),
    ]

    for phase in phases {
      var state = DictationState(phase: phase)
      let effect = DictationReducer.reduce(state: &state, action: .cancelled)

      #expect(state.phase == .idle)
      #expect(effect == nil)
    }
  }

  @Test("a cancelled recording forgets it reached the cap, so the next one can auto-finish again")
  func cancellingClearsTheAutoFinishLatch() {
    var state = DictationState(phase: .recording(elapsed: .milliseconds(59_900), level: 0.2))
    #expect(DictationReducer.reduce(state: &state, action: .tick(elapsed: .seconds(60), level: 0.2)) == .autoFinish)

    _ = DictationReducer.reduce(state: &state, action: .cancelled)
    _ = DictationReducer.reduce(state: &state, action: .started)
    _ = DictationReducer.reduce(state: &state, action: .tick(elapsed: .milliseconds(59_900), level: 0.2))

    let effect = DictationReducer.reduce(state: &state, action: .tick(elapsed: .seconds(60), level: 0.2))
    #expect(effect == .autoFinish)
  }

  @Test("the cap is the 60 s the gateway and its providers accept")
  func capIsSixtySeconds() {
    #expect(DictationState.maxDuration == .seconds(60))
    #expect(DictationState().phase == .idle)
  }
}

/// The only part of `AudioRecorderService` a simulator can exercise: the
/// decibel → 0…1 mapping behind the composer's level meter. Everything else
/// needs a microphone, and A8 covers it through a fake recorder.
@Suite("Audio recorder level meter")
struct AudioRecorderLevelTests {
  @Test("silence maps to zero")
  func silenceIsZero() {
    #expect(AudioRecorderService.normalizedLevel(fromDecibels: -160) == 0)
    #expect(AudioRecorderService.normalizedLevel(fromDecibels: -60) == 0)
  }

  @Test("full scale maps to one, and anything above it is clamped")
  func fullScaleIsOne() {
    #expect(AudioRecorderService.normalizedLevel(fromDecibels: 0) == 1)
    #expect(AudioRecorderService.normalizedLevel(fromDecibels: 5) == 1)
  }

  @Test("the mapping is the amplitude ratio, not the raw decibels")
  func mappingIsAmplitude() {
    #expect(abs(AudioRecorderService.normalizedLevel(fromDecibels: -20) - 0.1) < 0.0001)
    #expect(abs(AudioRecorderService.normalizedLevel(fromDecibels: -6) - 0.5012) < 0.001)
  }
}

/// `AudioLevelBroadcaster` is the part of the recorder that decides who sees
/// the meter, and it is pure Swift — no microphone needed.
@Suite("Audio level broadcast")
struct AudioLevelBroadcasterTests {
  @Test("every access is an independent stream, and all of them receive the meter")
  func everyConsumerReceivesTheMeter() async {
    let broadcaster = AudioLevelBroadcaster()
    let first = broadcaster.stream
    let second = broadcaster.stream
    var firstLevels = first.makeAsyncIterator()
    var secondLevels = second.makeAsyncIterator()
    #expect(broadcaster.consumerCount == 2)

    broadcaster.yield(0.25)

    #expect(await firstLevels.next() == 0.25)
    #expect(await secondLevels.next() == 0.25)
  }

  @Test(
    "cancelling one consumer's task leaves the others live — with a single shared stream the meter would be dead for the rest of the app's life"
  )
  func cancellingOneConsumerLeavesTheOthersLive() async {
    let broadcaster = AudioLevelBroadcaster()
    let survivor = broadcaster.stream
    var survivorLevels = survivor.makeAsyncIterator()

    let abandoned = Task {
      for await _ in broadcaster.stream {}
    }
    await waitUntil { broadcaster.consumerCount == 2 }
    abandoned.cancel()
    await abandoned.value
    await waitUntil { broadcaster.consumerCount == 1 }
    #expect(broadcaster.consumerCount == 1)

    broadcaster.yield(0.75)
    #expect(await survivorLevels.next() == 0.75)
  }

  @Test("finish ends every consumer's loop, and the stream taken for the next recording is live")
  func finishEndsEveryLoopAndTheNextStreamIsLive() async {
    let broadcaster = AudioLevelBroadcaster()
    let first = broadcaster.stream
    let second = broadcaster.stream
    var firstLevels = first.makeAsyncIterator()
    var secondLevels = second.makeAsyncIterator()
    broadcaster.yield(0.5)
    #expect(await firstLevels.next() == 0.5)
    #expect(await secondLevels.next() == 0.5)

    broadcaster.finish()

    #expect(await firstLevels.next() == nil)
    #expect(await secondLevels.next() == nil)
    #expect(broadcaster.consumerCount == 0)

    let next = broadcaster.stream
    var nextLevels = next.makeAsyncIterator()
    broadcaster.yield(0.9)
    #expect(await nextLevels.next() == 0.9)
  }

  /// A consumer deregisters itself from its termination handler, which runs on
  /// the cancelled task's own schedule — hence a bounded poll rather than a
  /// fixed sleep.
  private func waitUntil(_ condition: @Sendable () -> Bool) async {
    for _ in 0..<200 {
      if condition() { return }
      try? await Task.sleep(for: .milliseconds(5))
    }
  }
}
