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
  /// Voice mode (B9): enqueues one PCM16 mono frame at `sampleRate` for
  /// immediate playback, alongside (not instead of) `playMP3`'s read-aloud
  /// path. A 0-byte `data` is a no-op rather than an error — the gateway can
  /// legitimately send an empty frame at the end of a turn.
  ///
  /// Default no-op via the extension below so existing `playMP3`-only
  /// conformers (test fakes) do not have to change; `AudioPlaybackService`
  /// overrides it with a real PCM player.
  func enqueuePCM(_ data: Data, sampleRate: Double) async
  /// Barge-in: stops PCM playback now and drops any buffered frames, without
  /// touching `playMP3`'s player. A no-op with nothing queued.
  func flush() async
}

extension AudioPlaying {
  func enqueuePCM(_ data: Data, sampleRate: Double) async {}
  func flush() async {}
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

  // MARK: PCM playback (voice mode, B9)
  //
  // A dedicated engine + player node, entirely separate from the
  // `AVAudioPlayer` above: `playMP3` and `enqueuePCM` are two different
  // playback mechanisms that happen to share this actor so the two never
  // fight over which one currently "owns" audio output.
  private let pcmEngine = AVAudioEngine()
  private let pcmPlayerNode = AVAudioPlayerNode()
  private var pcmFormat: AVAudioFormat?

  var isPlaying: Bool { player?.isPlaying ?? false }

  init() {
    // Attached once, up front: `AVAudioPlayerNode.stop()`/`.reset()` are safe
    // to call on an attached-but-never-connected node, which is exactly the
    // idle state a `flush()` with nothing queued finds it in.
    pcmEngine.attach(pcmPlayerNode)
  }

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
    // `stop()` ends ALL playback this actor owns, not just the MP3 path —
    // ending a read-aloud clip should not leave a stray PCM frame queued
    // behind it (or vice versa).
    await flush()
  }

  func enqueuePCM(_ data: Data, sampleRate: Double) async {
    // An empty frame is not an error — the gateway can legitimately send one
    // at the end of a turn — but there is nothing to build a buffer from.
    guard !data.isEmpty else { return }
    guard let format = reconnectedFormat(sampleRate: sampleRate) else { return }

    let frameCount = UInt32(data.count / MemoryLayout<Int16>.size)
    guard frameCount > 0,
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount)
    else { return }
    buffer.frameLength = frameCount

    guard let channel = buffer.int16ChannelData else { return }
    data.withUnsafeBytes { raw in
      guard let base = raw.bindMemory(to: Int16.self).baseAddress else { return }
      channel[0].update(from: base, count: Int(frameCount))
    }

    if !pcmEngine.isRunning {
      // Nothing sensible to do if the engine refuses to start (no output
      // route, e.g. a Mac host with audio disabled) — the frame is simply
      // dropped rather than throwing, since `enqueuePCM` promises not to.
      try? pcmEngine.start()
    }
    pcmPlayerNode.scheduleBuffer(buffer, completionHandler: nil)
    if !pcmPlayerNode.isPlaying {
      pcmPlayerNode.play()
    }
  }

  func flush() async {
    // `stop()` (not `pause()`): a stopped player node drops every buffer
    // already scheduled, which is the whole point of barge-in — the agent's
    // voice must go silent immediately, not after draining its queue.
    pcmPlayerNode.stop()
    pcmPlayerNode.reset()
  }

  /// The PCM path plays exactly one sample rate at a time; a change means
  /// disconnecting and reconnecting the node at the new rate. Returns the
  /// live format to build the next buffer against, or `nil` if the format
  /// itself is invalid (an unsupported sample rate from the gateway).
  private func reconnectedFormat(sampleRate: Double) -> AVAudioFormat? {
    if let pcmFormat, pcmFormat.sampleRate == sampleRate {
      return pcmFormat
    }
    guard
      let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true
      )
    else { return nil }

    let wasRunning = pcmEngine.isRunning
    if wasRunning { pcmEngine.stop() }
    pcmPlayerNode.reset()
    pcmEngine.disconnectNodeOutput(pcmPlayerNode)
    pcmEngine.connect(pcmPlayerNode, to: pcmEngine.mainMixerNode, format: format)
    pcmFormat = format
    if wasRunning { try? pcmEngine.start() }
    return format
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
