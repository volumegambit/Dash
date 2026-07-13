import AVFoundation
import SwiftUI
import UIKit

struct QRScannerView: View {
  @Environment(PairingFeature.self) private var feature
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(spacing: 20) {
      ZStack {
        RoundedRectangle(cornerRadius: 24)
          .fill(Color.black.gradient)
        RoundedRectangle(cornerRadius: 20)
          .strokeBorder(.white.opacity(0.8), lineWidth: 3)
          .frame(width: 230, height: 230)
        Image(systemName: scannerSymbol)
          .font(.system(size: 64, weight: .light))
          .foregroundStyle(.white)
          .accessibilityHidden(true)
      }
      .frame(maxWidth: 520)
      .aspectRatio(1, contentMode: .fit)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(scannerLabel)

      Text(scannerLabel)
        .font(.headline)
        .multilineTextAlignment(.center)

      Text("The code contains the gateway address and connection credentials.")
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)

      PairingStatusView(state: feature.state)

      Spacer(minLength: 0)

      VStack(spacing: 10) {
        Button {
          let value = UIPasteboard.general.string ?? ""
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
    }
    .padding(20)
    .background(Color(uiColor: .systemGroupedBackground))
    .navigationTitle("Scan code")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Button("Close") {
          dismiss()
          Task { await feature.stopScanning() }
        }
        .frame(minWidth: 44, minHeight: 44)
      }
    }
    .task { await feature.requestCameraAndScan() }
    .onDisappear {
      Task { await feature.stopScanning() }
    }
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
