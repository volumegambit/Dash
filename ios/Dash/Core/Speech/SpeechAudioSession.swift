@preconcurrency import AVFoundation
import Foundation

/// The one place that touches `AVAudioSession` for speech, so recording,
/// read-aloud and (Phase B) conversation mode cannot drift into three
/// different category/mode combinations.
/// See `docs/plans/2026-09-10-speech-design.md` §4 iOS.
///
/// Callers activate before they start audio and `deactivate()` when they are
/// done; the recorder and the players deliberately do not configure the
/// session themselves, because the session is process-wide and the last writer
/// would win.
enum SpeechAudioSession {
  /// Dictation (Phase A). `.playAndRecord` rather than `.record` so an
  /// in-flight read-aloud or a notification sound is not silenced by arming
  /// the mic, `.defaultToSpeaker` so a phone with no headset records and plays
  /// through the speaker instead of the earpiece, and `.allowBluetoothHFP` so
  /// AirPods are a usable microphone.
  static func activateRecording() throws {
    try activate(
      category: .playAndRecord,
      mode: .default,
      options: [.defaultToSpeaker, .allowBluetoothHFP]
    )
  }

  /// Read aloud (Phase A). `.spokenAudio` is the mode iOS reserves for speech
  /// playback: it ducks other audio the way podcast apps do and keeps playing
  /// with the ring switch silenced, which is what "read this message to me"
  /// has to do.
  static func activatePlayback() throws {
    try activate(category: .playback, mode: .spokenAudio, options: [])
  }

  /// Conversation mode (Phase B). `.voiceChat` turns on the system's echo
  /// canceller, which is what makes barge-in over the built-in speaker
  /// possible at all — without it the microphone hears the agent's own voice
  /// and interrupts itself. No caller yet; it lives here so Phase B does not
  /// re-derive the session setup.
  static func activateVoiceChat() throws {
    try activate(
      category: .playAndRecord,
      mode: .voiceChat,
      options: [.defaultToSpeaker, .allowBluetoothHFP]
    )
  }

  /// `.notifyOthersOnDeactivation` hands the route back to whatever was
  /// playing before (music, a podcast) instead of leaving it paused.
  ///
  /// Deliberately not `throws`: deactivation fails when something else in the
  /// process still holds audio running, and there is nothing a caller in a
  /// teardown path can usefully do about it.
  static func deactivate() {
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
  }

  private static func activate(
    category: AVAudioSession.Category,
    mode: AVAudioSession.Mode,
    options: AVAudioSession.CategoryOptions
  ) throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(category, mode: mode, options: options)
    try session.setActive(true)
  }
}
