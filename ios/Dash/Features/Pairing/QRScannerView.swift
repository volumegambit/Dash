import AVFoundation
import SwiftUI
import UIKit

struct QRScannerView: View {
  @Environment(PairingFeature.self) private var feature
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    ScrollView {
      VStack(spacing: 20) {
        ZStack {
          RoundedRectangle(cornerRadius: 24)
            .fill(Color.black.gradient)
          if let previewSource = feature.scannerPreviewSource {
            QRScannerPreview(source: previewSource)
              .clipShape(RoundedRectangle(cornerRadius: 24))
          }
          RoundedRectangle(cornerRadius: 20)
            .strokeBorder(.white.opacity(0.8), lineWidth: 3)
            .frame(width: 230, height: 230)
          if feature.cameraAuthorization != .authorized {
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

        Text("The code contains the gateway address and connection credentials.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)

        PairingStatusView(state: feature.state)
      }
      .frame(maxWidth: 520)
      .padding(20)
      .frame(maxWidth: .infinity)
    }
    .background(Color(uiColor: .systemGroupedBackground))
    .navigationTitle("Scan code")
    .navigationBarTitleDisplayMode(.inline)
    .safeAreaInset(edge: .bottom, spacing: 0) {
      fallbackActions
    }
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Button("Close") {
          feature.cancelPairing()
          dismiss()
        }
        .frame(minWidth: 44, minHeight: 44)
      }
    }
    .task { await feature.requestCameraAndScan() }
    .onDisappear {
      feature.cancelPairing()
      Task { await feature.stopScanning() }
    }
  }

  private var fallbackActions: some View {
    VStack(spacing: 10) {
      Button {
        let value = UIPasteboard.general.string ?? ""
        feature.invalidateScanning()
        Task {
          await feature.stopScanning()
          await feature.pair(rawPayload: value)
        }
      } label: {
        Label("Paste Pairing Code", systemImage: "doc.on.clipboard")
          .frame(maxWidth: .infinity, minHeight: 44)
      }
      .buttonStyle(.bordered)
      .accessibilityIdentifier("pairing.paste")

      NavigationLink(value: PairingRoute.manual) {
        Label("Enter Manually", systemImage: "keyboard")
          .frame(maxWidth: .infinity, minHeight: 44)
      }
      .buttonStyle(.bordered)
      .accessibilityIdentifier("pairing.manual")
    }
    .frame(maxWidth: 520)
    .disabled(feature.state.isWorking)
    .padding(.horizontal, 20)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity)
    .background(.regularMaterial)
  }

  private var scannerSymbol: String {
    switch feature.cameraAuthorization {
    case .denied, .restricted:
      "camera.fill"
    case .authorized, .notDetermined:
      "qrcode.viewfinder"
    @unknown default:
      "camera.fill"
    }
  }

  private var scannerLabel: String {
    switch feature.cameraAuthorization {
    case .denied, .restricted:
      "Camera access is unavailable. Paste the code or enter the connection manually."
    case .authorized, .notDetermined:
      "Point the camera at the Dash pairing code in Mission Control."
    @unknown default:
      "Paste the code or enter the connection manually."
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
