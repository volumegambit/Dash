import SwiftUI
import UIKit

struct ConnectView: View {
  @Environment(PairingFeature.self) private var feature

  var body: some View {
    ScrollView {
      VStack(spacing: 28) {
        Spacer(minLength: 24)

        VStack(spacing: 16) {
          Image(systemName: "link.circle.fill")
            .font(.system(size: 68, weight: .medium))
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(DashTheme.accent)
            .accessibilityHidden(true)

          VStack(spacing: 8) {
            Text("Connect to Dash")
              .font(.largeTitle.bold())
              .multilineTextAlignment(.center)
            Text("Pair this device with the gateway that runs your agents.")
              .font(.body)
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.center)
          }
        }

        VStack(spacing: 12) {
          NavigationLink(value: PairingRoute.scanner) {
            Label("Scan QR Code", systemImage: "qrcode.viewfinder")
              .frame(maxWidth: .infinity, minHeight: 44)
          }
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("pairing.scan")
          .accessibilityHint("Opens the camera scanner. Paste and manual entry remain available.")

          Button {
            let value = UIPasteboard.general.string ?? ""
            Task { await feature.pair(rawPayload: value) }
          } label: {
            Label("Paste Pairing Code", systemImage: "doc.on.clipboard")
              .frame(maxWidth: .infinity, minHeight: 44)
          }
          .buttonStyle(.bordered)
          .accessibilityIdentifier("pairing.paste")
          .accessibilityHint("Reads a Dash pairing code from the clipboard.")

          NavigationLink(value: PairingRoute.manual) {
            Label("Enter Manually", systemImage: "keyboard")
              .frame(maxWidth: .infinity, minHeight: 44)
          }
          .buttonStyle(.bordered)
          .accessibilityIdentifier("pairing.manual")
          .accessibilityHint("Opens fields for a local or relay gateway connection.")
        }
        .disabled(feature.state.isWorking)

        PairingStatusView(state: feature.state)

        Label(
          "Connection secrets are stored only in this device's Keychain.",
          systemImage: "lock.shield"
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .accessibilityElement(children: .combine)

        Spacer(minLength: 12)
      }
      .frame(maxWidth: 520)
      .padding(.horizontal, 24)
      .frame(maxWidth: .infinity)
    }
    .background(Color(uiColor: .systemGroupedBackground))
    .navigationTitle("Connect")
    .navigationBarTitleDisplayMode(.inline)
  }
}

struct PairingStatusView: View {
  let state: PairingState

  var body: some View {
    switch state {
    case .idle, .paired:
      EmptyView()
    case .validating:
      statusRow(title: "Checking pairing code", systemImage: "hourglass")
    case .verifying(let step):
      statusRow(title: step.rawValue, systemImage: "arrow.triangle.2.circlepath")
    case .failed(let failure):
      VStack(alignment: .leading, spacing: 6) {
        Label(failure.title, systemImage: "exclamationmark.triangle.fill")
          .font(.headline)
          .foregroundStyle(.red)
        Text(failure.message)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(16)
      .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
      .accessibilityElement(children: .combine)
    }
  }

  private func statusRow(title: String, systemImage: String) -> some View {
    Label(title, systemImage: systemImage)
      .font(.subheadline.weight(.medium))
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity, minHeight: 44)
      .padding(.horizontal, 12)
      .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
      .accessibilityLabel(title)
  }
}
