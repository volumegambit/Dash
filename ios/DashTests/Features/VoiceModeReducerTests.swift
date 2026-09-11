import Foundation
import SwiftUI
import Testing

@testable import Dash

/// The hands-free voice session's state machine (speech Phase B, Task B9).
///
/// Every rule in the task brief has a row here, because the reducer is the
/// only part of voice mode that can be exercised without a microphone, an
/// audio route or a socket — the simulator has none of the three.
@Suite("Voice mode reducer")
struct VoiceModeReducerTests {
  // MARK: - Start

  @Test("started asks the gateway for a session and shows connecting")
  func startedSendsStart() {
    var state = VoiceModeState()

    let effects = VoiceModeReducer.reduce(state: &state, action: .started)

    #expect(effects == [.sendStart])
    #expect(state.phase == .connecting)
  }

  // MARK: - voice_state

  @Test("voice_state drives the phase")
  func voiceStateDrivesThePhase() {
    let table: [(VoiceState, VoiceModeState.Phase)] = [
      (.listening, .listening),
      (.transcribing, .transcribing),
      (.thinking, .thinking),
      (.speaking, .speaking),
      (.muted, .muted),
    ]

    for (frameState, phase) in table {
      var state = VoiceModeState()
      let effects = VoiceModeReducer.reduce(
        state: &state,
        action: .frame(.voiceState(id: "v1", state: frameState, turnId: nil))
      )
      #expect(state.phase == phase, "\(frameState) should map to \(phase)")
      #expect(effects.isEmpty)
    }
  }

  @Test("a state this build has never heard of changes nothing")
  func unknownVoiceStateIsIgnored() {
    var state = VoiceModeState(phase: .listening)

    let effects = VoiceModeReducer.reduce(
      state: &state,
      action: .frame(.voiceState(id: "v1", state: .unknown, turnId: nil))
    )

    #expect(state.phase == .listening)
    #expect(effects.isEmpty)
  }

  @Test("voice_state stopped is ignored — the session ends on voice_stopped")
  func stoppedVoiceStateIsIgnored() {
    var state = VoiceModeState(phase: .thinking)

    let effects = VoiceModeReducer.reduce(
      state: &state,
      action: .frame(.voiceState(id: "v1", state: .stopped, turnId: nil))
    )

    #expect(state.phase == .thinking)
    #expect(effects.isEmpty)
  }

  @Test("listening after speaking clears the assistant caption and flushes playback")
  func listeningAfterSpeakingClearsTheCaption() {
    var state = VoiceModeState(phase: .speaking, assistantCaption: "Sunny and warm.")

    let effects = VoiceModeReducer.reduce(
      state: &state,
      action: .frame(.voiceState(id: "v1", state: .listening, turnId: nil))
    )

    #expect(state.phase == .listening)
    #expect(state.assistantCaption.isEmpty)
    #expect(effects == [.flushPlayback])
  }

  @Test("any phase change away from speaking flushes playback")
  func leavingSpeakingFlushesPlayback() {
    for next in [VoiceState.thinking, .transcribing, .muted] {
      var state = VoiceModeState(phase: .speaking, assistantCaption: "Half a sentence")
      let effects = VoiceModeReducer.reduce(
        state: &state,
        action: .frame(.voiceState(id: "v1", state: next, turnId: nil))
      )
      #expect(effects == [.flushPlayback], "leaving speaking for \(next) must flush")
      // Only `listening` clears the caption: the others are still the same
      // assistant turn, mid-sentence.
      #expect(state.assistantCaption == "Half a sentence")
    }
  }

  @Test("a re-announced state changes nothing and does not flush")
  func reAnnouncedStateIsANoOp() {
    var state = VoiceModeState(phase: .speaking, assistantCaption: "Still talking")

    let effects = VoiceModeReducer.reduce(
      state: &state,
      action: .frame(.voiceState(id: "v1", state: .speaking, turnId: "turn-1"))
    )

    #expect(effects.isEmpty)
    #expect(state.assistantCaption == "Still talking")
  }

  // MARK: - voice_transcript

  @Test("a partial transcript only updates the caption")
  func partialTranscriptUpdatesTheCaption() {
    var state = VoiceModeState(phase: .listening)

    let effects = VoiceModeReducer.reduce(
      state: &state,
      action: .frame(.voiceTranscript(id: "v1", text: "what's the", final: false, turnId: nil))
    )

    #expect(state.userCaption == "what's the")
    #expect(effects.isEmpty)
  }

  @Test("a final transcript without a turn id starts no row — the queued-utterance case")
  func finalTranscriptWithoutATurnIDStartsNoRow() {
    var state = VoiceModeState(phase: .listening)

    let effects = VoiceModeReducer.reduce(
      state: &state,
      action: .frame(
        .voiceTranscript(id: "v1", text: "what's the weather", final: true, turnId: nil)
      )
    )

    #expect(state.userCaption == "what's the weather")
    #expect(effects.isEmpty)
  }

  @Test("a transcript carrying a turn id starts the optimistic row")
  func transcriptWithATurnIDStartsTheLocalTurn() {
    var state = VoiceModeState(phase: .transcribing)

    let effects = VoiceModeReducer.reduce(
      state: &state,
      action: .frame(
        .voiceTranscript(id: "v1", text: "what's the weather", final: true, turnId: "turn-7")
      )
    )

    #expect(state.userCaption == "what's the weather")
    #expect(effects == [.startLocalTurn(turnID: "turn-7", text: "what's the weather")])
  }

  @Test("an empty transcript never starts a row")
  func emptyTranscriptStartsNoRow() {
    var state = VoiceModeState(phase: .transcribing)

    let effects = VoiceModeReducer.reduce(
      state: &state,
      action: .frame(.voiceTranscript(id: "v1", text: "", final: true, turnId: "turn-7"))
    )

    #expect(effects.isEmpty)
  }

  // MARK: - voice_speech

  @Test("voice_speech appends the caption and plays the chunk")
  func speechAppendsAndPlays() {
    var state = VoiceModeState(phase: .speaking, assistantCaption: "Sunny")
    let audio = Data([0x01, 0x02, 0x03, 0x04])

    let effects = VoiceModeReducer.reduce(
      state: &state,
      action: .frame(
        .voiceSpeech(
          id: "v1",
          seq: 3,
          audio: audio.base64EncodedString(),
          format: "pcm16",
          sampleRate: 24_000,
          text: " and warm."
        )
      )
    )

    #expect(state.assistantCaption == "Sunny and warm.")
    #expect(effects == [.play(audio, sampleRate: 24_000, format: "pcm16")])
  }

  @Test("an mp3 chunk with no sample rate still plays")
  func mp3ChunkPlaysWithoutASampleRate() {
    var state = VoiceModeState(phase: .speaking)
    let audio = Data([0x49, 0x44, 0x33])

    let effects = VoiceModeReducer.reduce(
      state: &state,
      action: .frame(
        .voiceSpeech(
          id: "v1",
          seq: 0,
          audio: audio.base64EncodedString(),
          format: "mp3",
          sampleRate: nil,
          text: "Hello"
        )
      )
    )

    #expect(effects == [.play(audio, sampleRate: nil, format: "mp3")])
  }

  @Test("a chunk whose audio will not decode still shows its text")
  func undecodableChunkStillCaptions() {
    var state = VoiceModeState(phase: .speaking)

    let effects = VoiceModeReducer.reduce(
      state: &state,
      action: .frame(
        .voiceSpeech(id: "v1", seq: 0, audio: "", format: "pcm16", sampleRate: 24_000, text: "Hi")
      )
    )

    #expect(state.assistantCaption == "Hi")
    #expect(effects.isEmpty)
  }

  // MARK: - voice_error

  @Test("a mid-session error is shown without ending the session")
  func midSessionErrorDoesNotEnd() {
    var state = VoiceModeState(phase: .thinking)

    let effects = VoiceModeReducer.reduce(
      state: &state,
      action: .frame(.voiceError(id: "v1", code: "provider", error: "The model timed out"))
    )

    #expect(state.error == "The model timed out")
    #expect(state.phase == .thinking)
    #expect(effects.isEmpty)
  }

  @Test("an error while connecting ends the session — a rejected voice_start sends no voice_stopped")
  func errorWhileConnectingEnds() {
    var state = VoiceModeState()

    let effects = VoiceModeReducer.reduce(
      state: &state,
      action: .frame(
        .voiceError(id: "v1", code: "unavailable", error: "No speech provider is available")
      )
    )

    #expect(state.phase == .ended(reason: "No speech provider is available"))
    #expect(state.error == "No speech provider is available")
    #expect(effects.isEmpty)
  }

  // MARK: - Ending

  @Test("voice_stopped ends with a reason and sends nothing")
  func voiceStoppedEnds() {
    let table: [(VoiceStopReason, String)] = [
      (.client, VoiceModeState.endedMessage),
      (.socket, VoiceModeState.connectionLostMessage),
      (.provider, VoiceModeState.providerStoppedMessage),
      (.replaced, VoiceModeState.replacedMessage),
      (.unknown, VoiceModeState.endedMessage),
    ]

    for (reason, message) in table {
      var state = VoiceModeState(phase: .speaking)
      let effects = VoiceModeReducer.reduce(
        state: &state,
        action: .frame(.voiceStopped(id: "v1", reason: reason))
      )
      #expect(state.phase == .ended(reason: message), "\(reason) should read \(message)")
      #expect(effects.isEmpty, "the gateway already stopped — do not send voice_stop back")
    }
  }

  @Test("a lost transport ends without sending anything")
  func transportLostEnds() {
    var state = VoiceModeState(phase: .listening)

    let effects = VoiceModeReducer.reduce(state: &state, action: .transportLost)

    #expect(state.phase == .ended(reason: VoiceModeState.connectionLostMessage))
    #expect(effects.isEmpty)
  }

  @Test("a capture interruption ends AND tells the gateway to stop")
  func captureInterruptedEndsAndStops() {
    var state = VoiceModeState(phase: .listening)

    let effects = VoiceModeReducer.reduce(state: &state, action: .captureInterrupted)

    #expect(state.phase == .ended(reason: VoiceModeState.microphoneStoppedMessage))
    #expect(effects == [.sendStop])
  }

  @Test("a local failure ends with the message on screen")
  func failedEnds() {
    var state = VoiceModeState()

    let effects = VoiceModeReducer.reduce(
      state: &state,
      action: .failed(VoiceModeState.permissionDeniedMessage)
    )

    #expect(state.phase == .ended(reason: VoiceModeState.permissionDeniedMessage))
    #expect(state.error == VoiceModeState.permissionDeniedMessage)
    #expect(effects.isEmpty)
  }

  @Test("stopRequested stops the gateway session and dismisses")
  func stopRequestedStopsAndDismisses() {
    var state = VoiceModeState(phase: .speaking)

    let effects = VoiceModeReducer.reduce(state: &state, action: .stopRequested)

    #expect(effects == [.sendStop, .dismiss])
    #expect(state.phase == .ended(reason: VoiceModeState.endedMessage))
  }

  @Test("closing an already-ended session only dismisses")
  func stopRequestedAfterEndingOnlyDismisses() {
    var state = VoiceModeState(phase: .ended(reason: VoiceModeState.connectionLostMessage))

    let effects = VoiceModeReducer.reduce(state: &state, action: .stopRequested)

    #expect(effects == [.dismiss])
  }

  @Test("nothing reaches an ended session")
  func endedIsTerminal() {
    let ended = VoiceModeState.Phase.ended(reason: VoiceModeState.endedMessage)
    let actions: [VoiceModeAction] = [
      .started,
      .frame(.voiceState(id: "v1", state: .listening, turnId: nil)),
      .frame(.voiceTranscript(id: "v1", text: "hello", final: true, turnId: "turn-9")),
      .muteToggled,
      .orbTapped,
      .captureInterrupted,
      .transportLost,
    ]

    for action in actions {
      var state = VoiceModeState(phase: ended)
      let effects = VoiceModeReducer.reduce(state: &state, action: action)
      #expect(effects.isEmpty, "\(action) must not act on an ended session")
      #expect(state.phase == ended)
      #expect(state.userCaption.isEmpty)
    }
  }

  // MARK: - Mute

  @Test("mute and unmute toggle the phase and tell the gateway")
  func muteToggles() {
    var state = VoiceModeState(phase: .listening)

    let muted = VoiceModeReducer.reduce(state: &state, action: .muteToggled)
    #expect(muted == [.sendMute(true)])
    #expect(state.phase == .muted)

    let unmuted = VoiceModeReducer.reduce(state: &state, action: .muteToggled)
    #expect(unmuted == [.sendMute(false)])
    // Optimistic: no `voice_state` arrives while muted, and the gateway
    // re-announces the real state the moment the mute lifts.
    #expect(state.phase == .listening)
  }

  @Test("muting while the assistant speaks does not cut it off")
  func mutingWhileSpeakingDoesNotFlush() {
    var state = VoiceModeState(phase: .speaking, assistantCaption: "Mid sentence")

    let effects = VoiceModeReducer.reduce(state: &state, action: .muteToggled)

    #expect(effects == [.sendMute(true)])
    #expect(state.assistantCaption == "Mid sentence")
  }

  @Test("mute is ignored before the session is live")
  func muteWhileConnectingIsIgnored() {
    var state = VoiceModeState()

    let effects = VoiceModeReducer.reduce(state: &state, action: .muteToggled)

    #expect(effects.isEmpty)
    #expect(state.phase == .connecting)
  }

  // MARK: - The orb

  @Test("tapping the orb while speaking interrupts playback locally")
  func orbTapInterruptsPlayback() {
    var state = VoiceModeState(phase: .speaking, userCaption: "what's the weather")

    let effects = VoiceModeReducer.reduce(state: &state, action: .orbTapped)

    #expect(effects == [.flushPlayback])
    #expect(state.userCaption.isEmpty)
    // Barge-in proper is the gateway's VAD to detect; the tap only silences
    // what this device has already buffered.
    #expect(state.phase == .speaking)
  }

  @Test("tapping the orb outside speaking does nothing")
  func orbTapIsInertWhenNotSpeaking() {
    for phase in [VoiceModeState.Phase.connecting, .listening, .thinking, .muted] {
      var state = VoiceModeState(phase: phase, userCaption: "kept")
      let effects = VoiceModeReducer.reduce(state: &state, action: .orbTapped)
      #expect(effects.isEmpty, "\(phase) has nothing to interrupt")
      #expect(state.userCaption == "kept")
    }
  }

  // MARK: - Presentation

  @Test("the state line reads the four labels the design names")
  func phaseTitles() {
    #expect(VoiceModeState.Phase.connecting.title == "Connecting…")
    #expect(VoiceModeState.Phase.listening.title == "Listening")
    // Transcribing is a sub-second transient between the user stopping and
    // the model starting; naming it separately makes the line flicker.
    #expect(VoiceModeState.Phase.transcribing.title == "Thinking")
    #expect(VoiceModeState.Phase.thinking.title == "Thinking")
    #expect(VoiceModeState.Phase.speaking.title == "Speaking")
    #expect(VoiceModeState.Phase.muted.title == "Muted")
    #expect(VoiceModeState.Phase.ended(reason: "Connection lost").title == "Connection lost")
  }

  @Test("audio is only sent while the session is live and unmuted")
  func sendsAudioOnlyWhenLive() {
    #expect(VoiceModeState(phase: .connecting).sendsAudio == false)
    #expect(VoiceModeState(phase: .listening).sendsAudio)
    #expect(VoiceModeState(phase: .transcribing).sendsAudio)
    #expect(VoiceModeState(phase: .thinking).sendsAudio)
    #expect(VoiceModeState(phase: .speaking).sendsAudio)
    #expect(VoiceModeState(phase: .muted).sendsAudio == false)
    #expect(VoiceModeState(phase: .ended(reason: "x")).sendsAudio == false)
  }
}

/// The orb's geometry is a pure function of `(phase, level, elapsed)`
/// precisely so it can be checked here rather than eyeballed in a capture.
@Suite("Voice orb")
struct VoiceOrbViewTests {
  @Test("listening breathes between 0.95 and 1.05 over three seconds")
  func listeningBreathes() {
    // A quarter and three quarters of the way through the 3 s cycle are the
    // extremes of a sine; the start and the midpoint are the resting size.
    #expect(VoiceOrbView.scale(for: .listening, level: 0, elapsed: 0) == 1)
    #expect(abs(VoiceOrbView.scale(for: .listening, level: 0, elapsed: 0.75) - 1.05) < 0.0001)
    #expect(abs(VoiceOrbView.scale(for: .listening, level: 0, elapsed: 2.25) - 0.95) < 0.0001)
    #expect(abs(VoiceOrbView.scale(for: .listening, level: 0, elapsed: 3) - 1) < 0.0001)
  }

  @Test("thinking pulses on a 1.2 second cycle, faster than listening breathes")
  func thinkingPulses() {
    #expect(abs(VoiceOrbView.scale(for: .thinking, level: 0, elapsed: 0.3) - 1.06) < 0.0001)
    #expect(abs(VoiceOrbView.scale(for: .thinking, level: 0, elapsed: 1.2) - 1) < 0.0001)
    // Transcribing shares the pulse — it shares the label too.
    #expect(
      VoiceOrbView.scale(for: .transcribing, level: 0, elapsed: 0.3)
        == VoiceOrbView.scale(for: .thinking, level: 0, elapsed: 0.3)
    )
  }

  @Test("speaking follows the microphone, not the clock")
  func speakingFollowsTheLevel() {
    #expect(VoiceOrbView.scale(for: .speaking, level: 0, elapsed: 0) == 1)
    #expect(VoiceOrbView.scale(for: .speaking, level: 1, elapsed: 0) == 1.25)
    // The same at any moment: no time term at all.
    #expect(
      VoiceOrbView.scale(for: .speaking, level: 0.5, elapsed: 0)
        == VoiceOrbView.scale(for: .speaking, level: 0.5, elapsed: 12.34)
    )
    // A level outside 0…1 cannot blow the orb past the frame.
    #expect(VoiceOrbView.scale(for: .speaking, level: 9, elapsed: 0) == 1.25)
    #expect(VoiceOrbView.scale(for: .speaking, level: -3, elapsed: 0) == 1)
  }

  @Test("the still phases are still")
  func stillPhasesAreStill() {
    #expect(VoiceOrbView.scale(for: .connecting, level: 1, elapsed: 7) == 1)
    #expect(VoiceOrbView.scale(for: .ended(reason: "Voice mode ended"), level: 1, elapsed: 7) == 1)
    #expect(VoiceOrbView.scale(for: .muted, level: 1, elapsed: 7) == 0.92)
  }

  @Test("Reduce Motion holds every phase at its resting size")
  func reduceMotionRests() {
    // The view passes `elapsed: 0` when it is not animating, which is what
    // makes the two time-driven phases sit still.
    #expect(VoiceOrbView.scale(for: .listening, level: 0, elapsed: 0) == 1)
    #expect(VoiceOrbView.scale(for: .thinking, level: 0, elapsed: 0) == 1)
  }
}
