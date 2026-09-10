@preconcurrency import AVFoundation
import Foundation

/// One read-aloud playback. `Sendable` so a `@MainActor` feature can hold it
/// and a fake can stand in for it under test — the simulator's audio route is
/// the host Mac's, so `AudioPlaybackService` itself is only exercised on a
/// device (A9 covers the feature through a fake).
///
/// The caller owns the audio session: `SpeechAudioSession.activatePlayback()`
/// before `playMP3`, `deactivate()` once it returns — for ANY reason.
protocol AudioPlaying: Sendable {
  /// Plays `data` and RETURNS WHEN PLAYBACK ENDS — at the end of the clip, or
  /// early because `stop()` was called. Throws when the bytes will not decode
  /// or the route refuses to start.
  func playMP3(_ data: Data) async throws
  /// Ends playback now. Any `playMP3` still awaiting returns rather than
  /// hanging; calling this with nothing playing is a no-op.
  func stop() async
  var isPlaying: Bool { get async }
}

enum AudioPlaybackError: Error, Equatable, Sendable {
  /// `AVAudioPlayer(data:)` refused the bytes, or the decoder failed mid-clip.
  /// In practice: the gateway handed back something that is not MP3.
  case couldNotDecode
  /// `AVAudioPlayer.play()` returned false — almost always the audio session
  /// was not activated, or another app holds the output route.
  case couldNotStart
}

/// `AVAudioPlayer` behind the `AudioPlaying` seam.
///
/// An actor because `AVAudioPlayer` is not `Sendable` and the delegate
/// callback arrives on an arbitrary queue: the player, its delegate and the
/// pending continuation are all confined here, so "did playback finish before
/// or after the caller stopped it?" is answered in one isolation domain
/// instead of being a race.
///
/// The continuation is nil'd BEFORE it is resumed on every path, because a
/// natural finish and a `stop()` can arrive together and resuming a
/// continuation twice traps.
actor AudioPlaybackService: AudioPlaying {
  private var player: AVAudioPlayer?
  private var delegate: PlaybackDelegate?
  private var continuation: CheckedContinuation<Void, Error>?

  var isPlaying: Bool { player?.isPlaying ?? false }

  func playMP3(_ data: Data) async throws {
    // Whatever was playing is over: read aloud is one voice at a time, and
    // the previous clip's caller has to be released before this one parks its
    // own continuation here.
    await stop()

    let player: AVAudioPlayer
    do {
      player = try AVAudioPlayer(data: data, fileTypeHint: AVFileType.mp3.rawValue)
    } catch {
      throw AudioPlaybackError.couldNotDecode
    }
    let delegate = PlaybackDelegate { [weak self] error in
      Task { await self?.finish(error: error) }
    }
    player.delegate = delegate
    player.prepareToPlay()
    guard player.play() else {
      throw AudioPlaybackError.couldNotStart
    }
    self.player = player
    self.delegate = delegate

    try await withCheckedThrowingContinuation { continuation in
      self.continuation = continuation
    }
  }

  func stop() async {
    // `AVAudioPlayer.stop()` does NOT call the delegate, so the pending
    // `playMP3` has to be released here or it hangs forever.
    player?.stop()
    clear()
    resume(throwing: nil)
  }

  private func finish(error: Error?) {
    clear()
    resume(throwing: error)
  }

  private func clear() {
    player?.delegate = nil
    player = nil
    delegate = nil
  }

  private func resume(throwing error: Error?) {
    guard let pending = continuation else { return }
    continuation = nil
    if let error {
      pending.resume(throwing: error)
    } else {
      pending.resume()
    }
  }
}

/// Forwards `AVAudioPlayerDelegate` — whose callbacks are nonisolated and
/// arrive on the player's own queue — back into the actor. `@unchecked
/// Sendable` for the same reason `AudioLevelBroadcaster` is: it holds only an
/// immutable `@Sendable` closure.
private final class PlaybackDelegate: NSObject, AVAudioPlayerDelegate, @unchecked Sendable {
  private let onFinish: @Sendable (Error?) -> Void

  init(onFinish: @escaping @Sendable (Error?) -> Void) {
    self.onFinish = onFinish
  }

  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    onFinish(flag ? nil : AudioPlaybackError.couldNotDecode)
  }

  func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
    onFinish(AudioPlaybackError.couldNotDecode)
  }
}
