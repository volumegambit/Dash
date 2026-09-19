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
  /// Fix round 2 (item 4): no default implementation — every conformer,
  /// including test fakes, implements this explicitly. A fake that silently
  /// no-ops here would let a B9 barge-in test pass without ever proving a
  /// frame was actually enqueued; `ReadAloudFeatureTests.swift`'s
  /// `FakeAudioPlayer` and `UITestScenarioSupport.swift`'s `UITestAudioPlayer`
  /// both record calls (`enqueued`/`flushCount`) so those tests can assert on
  /// them.
  func enqueuePCM(_ data: Data, sampleRate: Double) async
  /// Voice mode: plays one COMPRESSED chunk (the gateway's `mp3` format)
  /// through the same engine `enqueuePCM` uses, by decoding it first.
  ///
  /// `playMP3` cannot serve voice mode. Its contract — stated above — is that
  /// the caller puts the session in `.playback` first, and voice mode cannot:
  /// its session is `.playAndRecord` with the microphone live, and switching
  /// to `.playback` would evict the capture. Routing compressed chunks down
  /// the same engine as PCM keeps voice mode on ONE playback path whatever
  /// text-to-speech model the gateway is configured with — which matters
  /// because that choice belongs to the user, and mp3-only models (the
  /// shipped default among them) are the common case.
  func enqueueCompressed(_ data: Data) async
  /// Returns once every buffer `enqueuePCM` has scheduled has finished
  /// PLAYING — `enqueuePCM` itself returns as soon as one is scheduled, which
  /// is the whole difference the gateway's drain gate turns on (F1).
  ///
  /// Returns immediately when nothing is outstanding, including when a frame
  /// was dropped because the engine would not start. A `flush()`/`stop()`
  /// releases every waiter too: the audio is over either way, and what makes
  /// a flush different from a natural end is decided by the CALLER (which
  /// does not acknowledge audio a barge-in discarded), not here.
  func awaitDrain() async
  /// Barge-in: stops PCM playback now and drops any buffered frames, without
  /// touching `playMP3`'s player. A no-op with nothing queued.
  func flush() async
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
  /// `nonisolated let`: the engine reference itself is immutable, and the
  /// configuration-change observer has to name it as the notification's object
  /// from outside the actor's isolation.
  private nonisolated let pcmEngine = AVAudioEngine()
  private let pcmPlayerNode = AVAudioPlayerNode()
  private var pcmFormat: AVAudioFormat?

  /// Fix round 2 (item 1): `pcmEngine.start()` itself cannot be forced to
  /// fail deterministically in a test — there is no host-controllable way to
  /// make real `AVAudioEngine` hardware refuse to start. This seam wraps the
  /// one call site that matters (whether `enqueuePCM`'s guard against a
  /// non-running engine actually holds) without needing a full tap-injection
  /// seam the way `AudioCaptureService.installTap` does: a test double here
  /// can throw WITHOUT ever touching the real `pcmEngine`, so
  /// `pcmEngine.isRunning` still correctly reports `false` afterward — the
  /// exact state `enqueuePCM`'s guard has to handle correctly, or crash on
  /// `pcmPlayerNode.play()`.
  private let startPCMEngine: @Sendable (AVAudioEngine) throws -> Void

  /// Buffers scheduled on `pcmPlayerNode` that have not yet played back, and
  /// whoever is waiting for them. Both are confined to this actor for the same
  /// reason the MP3 continuation is: the completion callback arrives on an
  /// arbitrary queue, so "did it finish before the caller flushed?" has to be
  /// answered in one isolation domain rather than raced.
  private var pendingPCMBuffers = 0
  private var drainWaiters: [CheckedContinuation<Void, Never>] = []

  var isPlaying: Bool { player?.isPlaying ?? false }

  /// Test-only window into the PCM engine, distinct from `isPlaying` (which
  /// only ever reflects `playMP3`'s `AVAudioPlayer`). Not part of
  /// `AudioPlaying` — `AudioPlaybackServiceTests` uses it to confirm
  /// `flush()`/`stop()` leave the engine stopped, not merely the player node
  /// idle.
  var isPCMEngineRunning: Bool { pcmEngine.isRunning }

  /// Test-only. `AVAudioEngineConfigurationChange` is posted BY the engine, so
  /// a test that wants to simulate a route change has to post it with the same
  /// object this service observes.
  nonisolated var engineForTesting: AVAudioEngine { pcmEngine }

  /// `AVAudioEngineConfigurationChange` observer, removed in `deinit`.
  private var configurationObserver: (any NSObjectProtocol)?

  init(startPCMEngine: @escaping @Sendable (AVAudioEngine) throws -> Void = { try $0.start() }) {
    self.startPCMEngine = startPCMEngine
    // Attached once, up front: `AVAudioPlayerNode.stop()`/`.reset()` are safe
    // to call on an attached-but-never-connected node, which is exactly the
    // idle state a `flush()` with nothing queued finds it in.
    pcmEngine.attach(pcmPlayerNode)
    observeConfigurationChanges()
  }

  /// An `AVAudioEngine`'s connections are made against the hardware format in
  /// force at the time, and iOS INVALIDATES them whenever the route or that
  /// format changes — it posts `AVAudioEngineConfigurationChange` and expects
  /// the graph to be rebuilt. An engine left on a stale graph keeps rendering
  /// at the old rate into a route running at the new one, so the reply plays
  /// at the wrong speed.
  ///
  /// Voice mode makes this the NORMAL case rather than an edge: arming the
  /// microphone moves the session to `.playAndRecord`/voice processing, which
  /// is itself a format change, and it lands while this engine is mid-reply.
  /// The simulator never reproduces it — its route is a fixed 48 kHz with no
  /// voice-processing hardware — which is why only a device shows the fault.
  ///
  /// Clearing `pcmFormat` is what forces the rebuild: the next chunk finds no
  /// cached format and reconnects against the current output.
  private nonisolated func observeConfigurationChanges() {
    let observer = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: pcmEngine,
      queue: nil
    ) { [weak self] _ in
      guard let self else { return }
      Task { await self.rebuildAfterConfigurationChange() }
    }
    Task { await setConfigurationObserver(observer) }
  }

  private func setConfigurationObserver(_ observer: any NSObjectProtocol) {
    configurationObserver = observer
  }

  /// Drops the invalidated graph. The buffers already scheduled die with it —
  /// they were queued for a route that no longer exists — so the drain waiters
  /// are released rather than left parked on completions that will never come.
  private func rebuildAfterConfigurationChange() {
    pcmEngine.stop()
    pcmPlayerNode.stop()
    pcmPlayerNode.reset()
    pcmFormat = nil
    pendingPCMBuffers = 0
    releaseDrainWaiters()
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

  func enqueueCompressed(_ data: Data) async {
    guard !data.isEmpty else { return }
    guard let decoded = Self.decode(data) else { return }
    await enqueuePCM(decoded.pcm, sampleRate: decoded.sampleRate)
  }

  /// Decodes compressed audio to the PCM16 the engine path takes.
  ///
  /// Through a temporary FILE because `AVAudioFile` is the only decoder that
  /// takes a container without the caller having to hand-feed packet
  /// descriptions: `AVAudioConverter` on an `AVAudioCompressedBuffer` needs
  /// the mp3 frame table this code would have to parse itself. A reply is a
  /// handful of sentence-sized chunks, so the write costs far less than that
  /// parser would.
  ///
  /// Returns nil rather than throwing: a chunk that will not decode is one
  /// silent sentence, and the reducer has already shown its words as a
  /// caption. Failing the whole session over it would be worse.
  /// `AVAudioFile` picks its decoder from the path extension, not from the
  /// bytes, so the container has to be named correctly or a perfectly valid
  /// file fails to open. Sniffed rather than taken from the frame's `format`
  /// field because the gateway legitimately sends WAV as well: a PCM-only
  /// model's audio is wrapped in a WAV container before it goes out.
  private nonisolated static func containerExtension(of data: Data) -> String {
    let magic = [UInt8](data.prefix(4))
    if magic.count >= 4, magic[0] == 0x52, magic[1] == 0x49, magic[2] == 0x46, magic[3] == 0x46 {
      return "wav"  // "RIFF"
    }
    if magic.count >= 4, magic[0] == 0x66, magic[1] == 0x74, magic[2] == 0x79, magic[3] == 0x70 {
      return "m4a"  // "ftyp" — an MPEG-4 container
    }
    if magic.count >= 4, magic[0] == 0x63, magic[1] == 0x61, magic[2] == 0x66, magic[3] == 0x66 {
      return "caf"  // "caff"
    }
    return "mp3"
  }

  nonisolated static func decode(_ data: Data) -> (pcm: Data, sampleRate: Double)? {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("dash-voice-\(UUID().uuidString)")
      .appendingPathExtension(Self.containerExtension(of: data))
    defer { try? FileManager.default.removeItem(at: url) }
    guard (try? data.write(to: url, options: .atomic)) != nil else { return nil }
    guard let file = try? AVAudioFile(forReading: url) else { return nil }

    let format = file.processingFormat
    let frames = AVAudioFrameCount(file.length)
    guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)
    else { return nil }
    guard (try? file.read(into: buffer)) != nil, buffer.frameLength > 0 else { return nil }
    guard let channels = buffer.floatChannelData else { return nil }

    // Downmixed to mono, because that is what the engine path connects at and
    // what every voice the gateway offers actually is. Averaging rather than
    // taking channel 0 keeps a stereo master's centre image at full level.
    let channelCount = Int(format.channelCount)
    let count = Int(buffer.frameLength)
    var pcm = Data(count: count * MemoryLayout<Int16>.size)
    pcm.withUnsafeMutableBytes { raw in
      guard let out = raw.baseAddress else { return }
      for index in 0..<count {
        var sum: Float = 0
        for channel in 0..<channelCount { sum += channels[channel][index] }
        let sample = max(-1, min(1, sum / Float(channelCount)))
        // 32767, not 32768: the positive side of Int16 stops one short, and
        // scaling by 32768 would wrap a full-scale sample to negative.
        let value = Int16(sample * 32_767).littleEndian
        out.storeBytes(of: value, toByteOffset: index * MemoryLayout<Int16>.size, as: Int16.self)
      }
    }
    return (pcm, format.sampleRate)
  }

  func enqueuePCM(_ data: Data, sampleRate: Double) async {
    // An empty frame is not an error — the gateway can legitimately send one
    // at the end of a turn — but there is nothing to build a buffer from.
    guard !data.isEmpty else { return }
    guard let format = reconnectedFormat(sampleRate: sampleRate) else { return }

    // Fix round 1 (concern 1): the player node connects to the mixer at
    // `AVAudioFormat(standardFormatWithSampleRate:channels:)` — Float32,
    // deinterleaved, the one format every `AVAudioEngine` mixer is
    // guaranteed to accept. Connecting at `.pcmFormatInt16` directly (the
    // original approach) was never actually exercised off a device and
    // `AVAudioEngine.connect` rejects an unsupported format with an
    // uncatchable ObjC exception rather than a Swift error — not a risk
    // worth taking. So PCM16 is decoded to Float32 here instead.
    //
    // Sample count truncates any odd trailing byte — half a sample cannot be
    // decoded, so it is dropped rather than treated as an error.
    let sampleCount = data.count / MemoryLayout<Int16>.size
    guard sampleCount > 0,
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sampleCount))
    else { return }
    buffer.frameLength = AVAudioFrameCount(sampleCount)

    guard let channel = buffer.floatChannelData else { return }
    data.withUnsafeBytes { raw in
      for index in 0..<sampleCount {
        // Fix round 2 (item 7): `loadUnaligned`, not `bindMemory` — `data`
        // can be a slice of a larger buffer (e.g. sliced off a network
        // frame), which is not guaranteed to start at a 2-byte-aligned
        // address; `bindMemory` assumes alignment `loadUnaligned` does not.
        let sample = raw.loadUnaligned(fromByteOffset: index * MemoryLayout<Int16>.size, as: Int16.self)
        // `Int16(littleEndian:)` makes the wire's byte order explicit rather
        // than relying on the host also being little-endian (true today, but
        // not something this line should quietly assume).
        channel[0][index] = Float(Int16(littleEndian: sample)) / 32_768.0
      }
    }

    if !pcmEngine.isRunning {
      // Nothing sensible to do if the engine refuses to start (no output
      // route, e.g. a host with audio disabled) — the frame is simply
      // dropped rather than throwing, since `enqueuePCM` promises not to.
      try? startPCMEngine(pcmEngine)
    }
    // Fix round 2 (item 1, BLOCKER): `AVAudioPlayerNode.play()` on a
    // non-running engine raises an uncatchable AVFoundation assertion — a
    // frame arriving while the engine failed to start (e.g. mid phone call)
    // would crash the app rather than merely losing that frame. The comment
    // above already promised to drop the frame on a failed start; this guard
    // is what actually keeps that promise instead of falling through to
    // `play()` regardless.
    guard pcmEngine.isRunning else { return }
    pendingPCMBuffers += 1
    // `.dataPlayedBack` — NOT the default `.dataRendered`: the drain gate
    // exists to answer "has the user heard this?", and rendering happens one
    // buffer ahead of the speaker.
    // The completion runs on AVFoundation's render-adjacent thread, outside
    // any actor. Build the hop back onto this actor here, as a `@Sendable`
    // closure, and hand the completion only that — Swift 6.1 (the CI
    // toolchain) rejects creating the `Task` inside the non-Sendable
    // completion closure as a potential data race; 6.2's region analysis
    // accepts it, but the explicit form compiles on both.
    let onPlayedBack: @Sendable () -> Void = { [weak self] in
      Task { await self?.pcmBufferFinished() }
    }
    pcmPlayerNode.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in
      onPlayedBack()
    }
    if !pcmPlayerNode.isPlaying {
      pcmPlayerNode.play()
    }
  }

  func awaitDrain() async {
    guard pendingPCMBuffers > 0 else { return }
    await withCheckedContinuation { continuation in
      drainWaiters.append(continuation)
    }
  }

  private func pcmBufferFinished() {
    // Clamped: a completion for a buffer a `flush()` already accounted for can
    // still arrive, and must not push the count negative.
    pendingPCMBuffers = max(0, pendingPCMBuffers - 1)
    if pendingPCMBuffers == 0 { releaseDrainWaiters() }
  }

  private func releaseDrainWaiters() {
    let waiters = drainWaiters
    drainWaiters = []
    for waiter in waiters { waiter.resume() }
  }

  func flush() async {
    // `stop()` (not `pause()`): a stopped player node drops every buffer
    // already scheduled, which is the whole point of barge-in — the agent's
    // voice must go silent immediately, not after draining its queue.
    pcmPlayerNode.stop()
    pcmPlayerNode.reset()
    // A stopped node fires no `.dataPlayedBack` callback for the buffers it
    // just dropped, so the count is cleared here and every waiter released —
    // otherwise an `awaitDrain()` parked across a barge-in would never return.
    pendingPCMBuffers = 0
    releaseDrainWaiters()
    // The engine itself is also stopped, not just the node: there is nothing
    // left to play once flushed, so there is no reason to keep the audio
    // hardware open — the next `enqueuePCM` restarts it on demand.
    if pcmEngine.isRunning {
      pcmEngine.stop()
    }
  }

  /// The PCM path plays exactly one sample rate at a time; a change means
  /// disconnecting and reconnecting the node at the new rate. Returns the
  /// live format to build the next buffer against, or `nil` if the format
  /// itself is invalid (an unsupported sample rate from the gateway).
  ///
  /// Float32/standard, not `.pcmFormatInt16` — see the fix-round-1 comment
  /// in `enqueuePCM` for why.
  private func reconnectedFormat(sampleRate: Double) -> AVAudioFormat? {
    if let pcmFormat, pcmFormat.sampleRate == sampleRate {
      return pcmFormat
    }
    guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)
    else { return nil }

    let wasRunning = pcmEngine.isRunning
    if wasRunning { pcmEngine.stop() }
    // Fix round 2 (item 6): `stop()` before `reset()` — `reset()` alone does
    // not clear the node's playing flag, so a reconnect mid-playback could
    // leave `pcmPlayerNode.isPlaying` true and `enqueuePCM`'s `if
    // !pcmPlayerNode.isPlaying { play() }` would then skip calling `play()`
    // on the newly connected node.
    pcmPlayerNode.stop()
    pcmPlayerNode.reset()
    // Same reason as `flush()`: a stopped node fires no `.dataPlayedBack` for
    // the buffers it just dropped, so an `awaitDrain()` parked across a sample
    // rate change would never return — and the playback chain behind it would
    // wedge until something flushed.
    pendingPCMBuffers = 0
    releaseDrainWaiters()
    pcmEngine.disconnectNodeOutput(pcmPlayerNode)
    pcmEngine.connect(pcmPlayerNode, to: pcmEngine.mainMixerNode, format: format)
    pcmFormat = format
    if wasRunning { try? startPCMEngine(pcmEngine) }
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
