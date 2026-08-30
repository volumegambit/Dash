import AVFoundation
import SwiftUI
import UIKit

/// Camera-scanning UI. Retained (currently unreferenced by product code) for
/// an upcoming signer-device feature that reuses camera scanning. QR pairing
/// entry — which used to host this view via `PairingFeature`/`PairingRoute`
/// — was retired in Task 7 of the iOS account sign-in plan; this view no
/// longer depends on either.
struct QRScannerView: View {
  let scanner: any QRScanning
  var onScanned: (String) -> Void = { _ in }
  var onCancel: () -> Void = {}

  @Environment(\.dismiss) private var dismiss
  @State private var cameraAuthorization: AVAuthorizationStatus = .notDetermined
  @State private var errorMessage: String?
  @State private var coordinator = ScanCoordinator()

  var body: some View {
    ScrollView {
      VStack(spacing: 20) {
        ZStack {
          RoundedRectangle(cornerRadius: 24)
            .fill(Color.black.gradient)
          if let previewSource = scanner.previewSource {
            QRScannerPreview(source: previewSource)
              .clipShape(RoundedRectangle(cornerRadius: 24))
          }
          RoundedRectangle(cornerRadius: 20)
            .strokeBorder(.white.opacity(0.8), lineWidth: 3)
            .frame(width: 230, height: 230)
          if cameraAuthorization != .authorized {
            Image(systemName: scannerSymbol)
              .font(.system(size: 64, weight: .light))
              .foregroundStyle(.white)
          }
        }
        .frame(maxWidth: 520)
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)

        Text(scannerLabel)
          .font(.headline)
          .multilineTextAlignment(.center)

        if let errorMessage {
          Text(errorMessage)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
        }
      }
      .frame(maxWidth: 520)
      .padding(20)
      .frame(maxWidth: .infinity)
    }
    .background(Color(uiColor: .systemGroupedBackground))
    .navigationTitle("Scan code")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Button("Close") {
          coordinator.stop()
          onCancel()
          dismiss()
        }
        .frame(minWidth: 44, minHeight: 44)
      }
    }
    .task { await runScan() }
    .onDisappear {
      coordinator.stop()
      Task { await scanner.stop() }
    }
  }

  private func runScan() async {
    let outcome = await coordinator.requestCameraAndScan(using: scanner) { authorization in
      cameraAuthorization = authorization
    }
    switch outcome {
    case .scanned(let payload):
      onScanned(payload)
    case .failed:
      errorMessage = "Couldn't scan the code. Try again."
    case .authorizationDenied, .ignored:
      break
    }
  }

  private var scannerSymbol: String {
    switch cameraAuthorization {
    case .denied, .restricted:
      "camera.fill"
    case .authorized, .notDetermined:
      "qrcode.viewfinder"
    @unknown default:
      "camera.fill"
    }
  }

  private var scannerLabel: String {
    switch cameraAuthorization {
    case .denied, .restricted:
      "Camera access is unavailable."
    case .authorized, .notDetermined:
      "Point the camera at the code."
    @unknown default:
      "Camera access is unavailable."
    }
  }
}

struct QRScannerPreview: UIViewRepresentable {
  let source: QRScannerPreviewSource

  func makeUIView(context: Context) -> QRScannerPreviewView {
    _ = context
    let view = QRScannerPreviewView(frame: .zero)
    view.attach(source)
    return view
  }

  func updateUIView(_ uiView: QRScannerPreviewView, context: Context) {
    _ = context
    uiView.attach(source)
  }

  static func dismantleUIView(_ uiView: QRScannerPreviewView, coordinator: Void) {
    _ = coordinator
    uiView.detach()
  }
}

protocol QRScannerPreviewRotating: AnyObject {
  var videoRotationAngle: CGFloat { get set }
  func isVideoRotationAngleSupported(_ angle: CGFloat) -> Bool
}

extension AVCaptureConnection: QRScannerPreviewRotating {}

enum QRScannerPreviewRotation {
  static func angle(for orientation: UIInterfaceOrientation) -> CGFloat? {
    switch orientation {
    case .portrait:
      90
    case .portraitUpsideDown:
      270
    case .landscapeLeft:
      180
    case .landscapeRight:
      0
    case .unknown:
      nil
    @unknown default:
      nil
    }
  }

  static func update(
    _ connection: (any QRScannerPreviewRotating)?,
    for orientation: UIInterfaceOrientation
  ) {
    guard let angle = angle(for: orientation),
      let connection,
      connection.isVideoRotationAngleSupported(angle)
    else {
      return
    }
    connection.videoRotationAngle = angle
  }
}

final class QRScannerPreviewView: UIView {
  override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

  var previewLayer: AVCaptureVideoPreviewLayer {
    layer as! AVCaptureVideoPreviewLayer
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    accessibilityElementsHidden = true
    previewLayer.videoGravity = .resizeAspectFill
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    accessibilityElementsHidden = true
    previewLayer.videoGravity = .resizeAspectFill
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    updateRotation()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    updateRotation()
  }

  func attach(_ source: QRScannerPreviewSource) {
    guard previewLayer.session !== source.session else { return }
    previewLayer.session = source.session
    updateRotation()
  }

  func detach() {
    previewLayer.session = nil
  }

  private func updateRotation() {
    guard let orientation = window?.windowScene?.interfaceOrientation else { return }
    QRScannerPreviewRotation.update(previewLayer.connection, for: orientation)
  }
}
