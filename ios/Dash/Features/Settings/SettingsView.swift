import SwiftUI

struct SettingsView: View {
  @Environment(SettingsFeature.self) private var feature
  @State private var showForgetConfirmation = false

  var body: some View {
    Form {
      Section("Gateway") {
        LabeledContent("Name", value: feature.gatewayLabel)
        LabeledContent("Gateway ID") {
          Text(feature.identity.gatewayId)
            .textSelection(.enabled)
            .multilineTextAlignment(.trailing)
        }
        LabeledContent("Public key", value: feature.publicKeyFingerprint)
      }

      Section("Connection") {
        LabeledContent("Type", value: feature.modeText)
        LabeledContent("Status", value: feature.connectionText)
        LabeledContent("Last sync") {
          if let lastSync = feature.lastSuccessfulSyncAt {
            Text(lastSync, format: .dateTime.year().month().day().hour().minute())
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
              Label("Reconnect", systemImage: "arrow.clockwise")
            }
            Spacer()
          }
          .frame(minHeight: 44)
        }
        .disabled(feature.isReconnecting || feature.isForgetting)
      }

      Section {
        Button("Disconnect & Forget", role: .destructive) {
          showForgetConfirmation = true
        }
        .frame(minHeight: 44)
        .disabled(feature.isForgetting || feature.isReconnecting)
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
  }

  private var errorPresented: Binding<Bool> {
    Binding(
      get: { feature.error != nil },
      set: { if $0 == false { feature.error = nil } }
    )
  }
}
