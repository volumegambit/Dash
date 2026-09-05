import SwiftUI
import UIKit

struct SettingsView: View {
  @Environment(SettingsFeature.self) private var feature
  @Environment(AppModel.self) private var appModel
  @State private var showForgetConfirmation = false
  @State private var approveDeviceViewModel: ApproveDeviceViewModel?
  @State private var didCopyPublicKey = false

  var body: some View {
    Form {
      Section("Gateway") {
        LabeledContent("Name") {
          // `LabeledContent(_:value:)` wraps a long value onto its own line
          // below the label, which is why a gateway hostname broke the
          // label-left/value-right rhythm every other row keeps. Middle
          // truncation because both ends of a hostname carry meaning — the
          // machine name and the domain — while the middle rarely does.
          Text(feature.gatewayLabel)
            .lineLimit(1)
            .truncationMode(.middle)
            .textSelection(.enabled)
        }
        LabeledContent("Gateway ID") {
          Text(feature.identity.gatewayId)
            .textSelection(.enabled)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        publicKeyRow
      }

      Section("Connection") {
        LabeledContent("Type", value: feature.modeText)
        LabeledContent("Status") {
          StatusBadge(
            title: LocalizedStringKey(feature.connectionText),
            systemImage: feature.connectionSystemImage,
            color: statusColor
          )
        }
        LabeledContent("Last sync") {
          if let lastSync = feature.lastSuccessfulSyncAt {
            // Was an absolute "5 Sep 2026 at 9:06 AM" — the longest value on
            // the screen, answering "when exactly" when the question being
            // asked is "is this current?".
            Text(RelativeTimestamp.label(for: lastSync))
          } else {
            Text("Never")
          }
        }

        Button {
          Task { await feature.reconnect() }
        } label: {
          HStack {
            if feature.isReconnecting {
              ProgressView()
            } else {
              Image(systemName: "arrow.clockwise")
            }
            Text(feature.reconnectButtonTitle)
            Spacer()
          }
          .frame(minHeight: 44)
        }
        .disabled(feature.canReconnect == false)
        .accessibilityLabel(feature.reconnectButtonTitle)
      }

      Section {
        Button("Approve a device") {
          approveDeviceViewModel = appModel.makeApproveDeviceViewModel()
        }
        .frame(minHeight: 44)
        .accessibilityIdentifier("account.approve-device")
      } header: {
        Text("Account")
      } footer: {
        Text("Scan the code shown on a browser or new device to let it sign in to your account.")
      }

      Section {
        Button("Disconnect & Forget", role: .destructive) {
          showForgetConfirmation = true
        }
        .frame(minHeight: 44)
        .disabled(feature.isForgetting)
        .accessibilityIdentifier("settings.disconnect")

        if feature.isForgetting {
          HStack {
            ProgressView()
            Text("Removing gateway data")
              .foregroundStyle(.secondary)
          }
          .accessibilityElement(children: .combine)
        }
      } header: {
        Text("Device")
      } footer: {
        Text(
          "Connection secrets, offline cache, drafts, and attachments for this gateway are removed from this device."
        )
      }
    }
    .accessibilityIdentifier("settings.list")
    .navigationTitle("Settings")
    .confirmationDialog(
      "Disconnect & Forget?",
      isPresented: $showForgetConfirmation,
      titleVisibility: .visible
    ) {
      Button("Disconnect & Forget", role: .destructive) {
        Task { await feature.disconnectAndForget(confirmed: true) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(
        "This removes this gateway's connection secrets, offline cache, drafts, and attachments from this device."
      )
    }
    .alert("Settings update failed", isPresented: errorPresented) {
      Button("OK") { feature.error = nil }
    } message: {
      Text(feature.error ?? "Dash couldn't update gateway settings.")
    }
    .sheet(isPresented: approveDeviceSheetPresented) {
      if let approveDeviceViewModel {
        ApproveDeviceView(viewModel: approveDeviceViewModel)
      }
    }
  }

  /// Tap to copy the full key (settings clarity 2026-09-05).
  ///
  /// The fingerprint is a verification affordance — you compare it against
  /// what the gateway reports — but it was truncated with no way to see or
  /// copy the whole value, and the row had no `textSelection` even though
  /// the Gateway ID row beside it did. Monospaced because comparing base64
  /// by eye in a proportional face is materially harder: `l`/`I`/`1` and
  /// `O`/`0` do not line up in columns.
  @ViewBuilder
  private var publicKeyRow: some View {
    LabeledContent("Public key") {
      if let key = feature.copyablePublicKey {
        Button {
          UIPasteboard.general.string = key
          withAnimation { didCopyPublicKey = true }
          Task {
            try? await Task.sleep(for: .seconds(2))
            withAnimation { didCopyPublicKey = false }
          }
        } label: {
          HStack(spacing: 6) {
            Text(didCopyPublicKey ? "Copied" : feature.publicKeyFingerprint)
              .font(.body.monospaced())
            Image(systemName: didCopyPublicKey ? "checkmark" : "doc.on.doc")
              .font(.footnote)
          }
        }
        .buttonStyle(.plain)
        .foregroundStyle(didCopyPublicKey ? DashTheme.success : Color.secondary)
        .accessibilityLabel("Public key \(feature.publicKeyFingerprint)")
        .accessibilityHint("Copies the full public key")
        .accessibilityIdentifier("settings.publicKey")
      } else {
        Text(feature.publicKeyFingerprint)
          .font(.body.monospaced())
      }
    }
  }

  private var statusColor: Color {
    switch feature.connectionSeverity {
    case .ok: DashTheme.success
    // `.orange` rather than a token: `OfflineBanner` already uses it for
    // exactly these states, and inventing `DashTheme.warning` for one of
    // the two call sites would fragment the scale rather than fix it.
    case .warning: .orange
    case .error: DashTheme.danger
    }
  }

  private var errorPresented: Binding<Bool> {
    Binding(
      get: { feature.error != nil },
      set: { if $0 == false { feature.error = nil } }
    )
  }

  private var approveDeviceSheetPresented: Binding<Bool> {
    Binding(
      get: { approveDeviceViewModel != nil },
      set: { if $0 == false { approveDeviceViewModel = nil } }
    )
  }
}
