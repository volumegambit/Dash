@preconcurrency import AVFoundation
import Foundation

protocol QRScanning: Actor {
  func authorizationStatus() -> AVAuthorizationStatus
  func requestAccess() async -> Bool
  func scan() async throws -> String
  func stop()
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

actor QRScannerService: QRScanning {
  private let runtime: any QRScannerRuntimeControlling

  init() {
    runtime = QRScannerRuntime()
  }

  init(runtime: any QRScannerRuntimeControlling) {
    self.runtime = runtime
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

actor UnavailableQRScanner: QRScanning {
  func authorizationStatus() -> AVAuthorizationStatus {
    .restricted
  }

  func requestAccess() async -> Bool {
    false
  }

  func scan() async throws -> String {
    throw QRScannerError.cameraUnavailable
  }

  func stop() {}
}

private final class QRScannerRuntime: QRScannerRuntimeControlling, @unchecked Sendable {
  private let queue = DispatchQueue(label: "app.dash.ios.qr-scanner", qos: .userInitiated)
  private let session = AVCaptureSession()
  private let output = AVCaptureMetadataOutput()
  private let requestLock = NSLock()

  private var isConfigured = false
  private var activeContinuation: AsyncStream<String>.Continuation?
  private var metadataDelegate: QRMetadataDelegate?
  private var requestedScanID: UUID?

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
