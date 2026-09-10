@preconcurrency import AVFoundation
import Foundation

/// Microphone permission, behind a protocol so `DictationFeature` (A8) and
/// Phase B's voice mode can be tested with a fake — the real prompt cannot be
/// answered from a test.
///
/// Microphone only: Dash transcribes on the gateway, so no Apple speech
/// recognition is used and `NSSpeechRecognitionUsageDescription` is not needed
/// (`docs/plans/2026-09-10-speech-design.md` §4 iOS).
protocol SpeechPermissionRequesting: Sendable {
  /// `true` once the microphone is usable. Returns `false` for a denial, and
  /// for an earlier denial it returns immediately without prompting again —
  /// iOS only ever asks once, which is why the UI has to offer a route to
  /// Settings rather than a second "Allow" button.
  func requestMicrophone() async -> Bool
}

struct SystemSpeechPermission: SpeechPermissionRequesting {
  func requestMicrophone() async -> Bool {
    // iOS 17 replaced `AVAudioSession.requestRecordPermission(_:)` with this;
    // the deployment target is 17.0, so the old spelling is not needed.
    await AVAudioApplication.requestRecordPermission()
  }
}
