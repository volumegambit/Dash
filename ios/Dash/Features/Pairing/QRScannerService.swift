@preconcurrency import AVFoundation
import Foundation

// Live product consumer: `ApproveDeviceView`'s scan-to-approve flow (Task 6
// of the signer-device plan). QR pairing entry, this service's FORMER
// consumer, was retired in Task 7 of the iOS account sign-in plan — see
// `PairingFeature.swift`.

final class QRScannerPreviewSource: @unchecked Sendable {
  let session: AVCaptureSession

  init(session: AVCaptureSession = AVCaptureSession()) {
    self.session = session
  }
}

protocol QRScanning: Actor {
  nonisolated var previewSource: QRScannerPreviewSource? { get }
  func authorizationStatus() -> AVAuthorizationStatus
  func requestAccess() async -> Bool
  func scan() async throws -> String
  func stop()
}

extension QRScanning {
  nonisolated var previewSource: QRScannerPreviewSource? { nil }
}

protocol QRScannerRuntimeControlling: Sendable {
  func start() async throws -> AsyncStream<String>
  func stop()
}

enum QRScannerError: Error, Equatable, Sendable {
  case cameraUnavailable
  case inputUnavailable
  case outputUnavailable
  case stopped
}

/// The result of one `ScanCoordinator.requestCameraAndScan` attempt.
/// `.ignored` covers every path where the attempt was superseded or
/// invalidated (stopped, cancelled, or a fresher scan started) before it
/// resolved — the caller should treat it exactly like "nothing happened".
enum ScanOutcome: Equatable, Sendable {
  case scanned(String)
  case authorizationDenied
  case failed
  case ignored
}

/// Drives one camera authorization + scan attempt against a `QRScanning`
/// actor, guarding against a result that arrives after the attempt has been
/// invalidated — a late permission callback, or a value already buffered on
/// the scanner's async stream when `stop()`/cancellation fires — reaching
/// the caller. Extracted out of `QRScannerView` so this guard has direct
/// test coverage instead of living only in untested SwiftUI view state.
@MainActor
final class ScanCoordinator {
  private var activeScanID: UUID?

  /// Runs the full authorization → scan flow. `onAuthorizationChange` is
  /// invoked synchronously (still on the caller's actor) each time the
  /// authorization status is read, but only while this attempt remains the
  /// active one.
  func requestCameraAndScan(
    using scanner: any QRScanning,
    onAuthorizationChange: (AVAuthorizationStatus) -> Void
  ) async -> ScanOutcome {
    let scanID = UUID()
    activeScanID = scanID
    var authorization = await scanner.authorizationStatus()
    guard isActive(scanID) else { return .ignored }
    onAuthorizationChange(authorization)
    if authorization == .notDetermined {
      _ = await scanner.requestAccess()
      guard isActive(scanID) else { return .ignored }
      authorization = await scanner.authorizationStatus()
      guard isActive(scanID) else { return .ignored }
      onAuthorizationChange(authorization)
    }
    guard authorization == .authorized else {
      invalidate(scanID)
      return .authorizationDenied
    }
    do {
      let payload = try await scanner.scan()
      try Task.checkCancellation()
      guard isActive(scanID) else { return .ignored }
      invalidate(scanID)
      return .scanned(payload)
    } catch is CancellationError {
      invalidate(scanID)
      return .ignored
    } catch QRScannerError.stopped {
      invalidate(scanID)
      return .ignored
    } catch {
      guard isActive(scanID) else { return .ignored }
      invalidate(scanID)
      return .failed
    }
  }

  /// Invalidates whatever attempt is currently active, so its eventual
  /// result (if any) resolves to `.ignored`.
  func stop() {
    activeScanID = nil
  }

  private func isActive(_ id: UUID) -> Bool {
    activeScanID == id
  }

  private func invalidate(_ id: UUID) {
    if activeScanID == id {
      activeScanID = nil
    }
  }
}

actor QRScannerService: QRScanning {
  nonisolated let previewSource: QRScannerPreviewSource?
  private let runtime: any QRScannerRuntimeControlling

  init() {
    let previewSource = QRScannerPreviewSource()
    self.previewSource = previewSource
    runtime = QRScannerRuntime(session: previewSource.session)
  }

  init(
    runtime: any QRScannerRuntimeControlling,
    previewSource: QRScannerPreviewSource? = nil
  ) {
    self.runtime = runtime
    self.previewSource = previewSource
  }

  func authorizationStatus() -> AVAuthorizationStatus {
    AVCaptureDevice.authorizationStatus(for: .video)
  }

  func requestAccess() async -> Bool {
    await AVCaptureDevice.requestAccess(for: .video)
  }

  func scan() async throws -> String {
    return try await withTaskCancellationHandler {
      try Task.checkCancellation()
      let stream = try await runtime.start()
      for await value in stream {
        try Task.checkCancellation()
        return value
      }
      throw QRScannerError.stopped
    } onCancel: {
      runtime.stop()
    }
  }

  func stop() {
    runtime.stop()
  }
}

private final class QRScannerRuntime: QRScannerRuntimeControlling, @unchecked Sendable {
  private let queue = DispatchQueue(label: "app.dash.ios.qr-scanner", qos: .userInitiated)
  private let session: AVCaptureSession
  private let output = AVCaptureMetadataOutput()
  private let requestLock = NSLock()

  private var isConfigured = false
  private var activeContinuation: AsyncStream<String>.Continuation?
  private var metadataDelegate: QRMetadataDelegate?
  private var requestedScanID: UUID?

  init(session: AVCaptureSession = AVCaptureSession()) {
    self.session = session
  }

  func start() async throws -> AsyncStream<String> {
    let scanID = UUID()
    setRequestedScanID(scanID)
    return try await withCheckedThrowingContinuation { continuation in
      queue.async { [self] in
        do {
          guard isRequested(scanID) else { throw QRScannerError.stopped }
          try configureIfNeeded()
          guard isRequested(scanID) else { throw QRScannerError.stopped }
          finishCaptureSession()
          guard isRequested(scanID) else { throw QRScannerError.stopped }

          let pair = AsyncStream.makeStream(
            of: String.self,
            bufferingPolicy: .bufferingNewest(1)
          )
          let delegate = QRMetadataDelegate(
            continuation: pair.continuation,
            didFinish: { [weak self] in self?.finishActiveScan(scanID: scanID) }
          )
          activeContinuation = pair.continuation
          metadataDelegate = delegate
          output.setMetadataObjectsDelegate(delegate, queue: queue)
          pair.continuation.onTermination = { [weak self] _ in
            self?.stop(scanID: scanID)
          }
          guard isRequested(scanID) else { throw QRScannerError.stopped }
          if session.isRunning == false {
            session.startRunning()
          }
          guard isRequested(scanID) else {
            finishCaptureSession()
            throw QRScannerError.stopped
          }
          continuation.resume(returning: pair.stream)
        } catch {
          _ = invalidate(scanID: scanID)
          finishCaptureSession()
          continuation.resume(throwing: error)
        }
      }
    }
  }

  func stop() {
    invalidateAllRequests()
    queue.async { [self] in
      finishCaptureSession()
    }
  }

  private func stop(scanID: UUID) {
    guard invalidate(scanID: scanID) else { return }
    queue.async { [self] in
      finishCaptureSession()
    }
  }

  private func configureIfNeeded() throws {
    guard isConfigured == false else { return }
    guard let camera = AVCaptureDevice.default(for: .video) else {
      throw QRScannerError.cameraUnavailable
    }
    let input: AVCaptureDeviceInput
    do {
      input = try AVCaptureDeviceInput(device: camera)
    } catch {
      throw QRScannerError.inputUnavailable
    }

    session.beginConfiguration()
    defer { session.commitConfiguration() }
    session.sessionPreset = .high
    guard session.canAddInput(input) else {
      throw QRScannerError.inputUnavailable
    }
    session.addInput(input)
    guard session.canAddOutput(output) else {
      throw QRScannerError.outputUnavailable
    }
    session.addOutput(output)
    guard output.availableMetadataObjectTypes.contains(.qr) else {
      throw QRScannerError.outputUnavailable
    }
    output.metadataObjectTypes = [.qr]
    isConfigured = true
  }

  private func finishActiveScan(scanID: UUID) {
    guard invalidate(scanID: scanID) else { return }
    finishCaptureSession()
  }

  private func finishCaptureSession() {
    output.setMetadataObjectsDelegate(nil, queue: nil)
    activeContinuation?.finish()
    activeContinuation = nil
    metadataDelegate = nil
    if session.isRunning {
      session.stopRunning()
    }
  }

  private func setRequestedScanID(_ scanID: UUID) {
    requestLock.lock()
    requestedScanID = scanID
    requestLock.unlock()
  }

  private func isRequested(_ scanID: UUID) -> Bool {
    requestLock.lock()
    defer { requestLock.unlock() }
    return requestedScanID == scanID
  }

  @discardableResult
  private func invalidate(scanID: UUID) -> Bool {
    requestLock.lock()
    defer { requestLock.unlock() }
    guard requestedScanID == scanID else { return false }
    requestedScanID = nil
    return true
  }

  private func invalidateAllRequests() {
    requestLock.lock()
    requestedScanID = nil
    requestLock.unlock()
  }
}

private final class QRMetadataDelegate: NSObject, AVCaptureMetadataOutputObjectsDelegate,
  @unchecked Sendable
{
  private let continuation: AsyncStream<String>.Continuation
  private let didFinish: @Sendable () -> Void
  private var delivered = false

  init(
    continuation: AsyncStream<String>.Continuation,
    didFinish: @escaping @Sendable () -> Void
  ) {
    self.continuation = continuation
    self.didFinish = didFinish
  }

  func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    _ = output
    _ = connection
    guard delivered == false,
      let code = metadataObjects.compactMap({
        ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue
      })
      .first
    else { return }
    delivered = true
    continuation.yield(code)
    continuation.finish()
    didFinish()
  }
}
