import SwiftUI

struct SettingsView: View {
  @Environment(SettingsFeature.self) private var feature
  @Environment(AppModel.self) private var appModel
  @State private var showForgetConfirmation = false
  @State private var approveDeviceViewModel: ApproveDeviceViewModel?

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
        // Presentation audit (iPad goal Phase D, Task 11): a
        // `confirmationDialog` is a POPOVER at iPad regular width, and UIKit
        // takes its source rect from the view the modifier is attached to.
        // Attached to the whole `settings.list` — where this used to live — it
        // anchored to the top-middle of the Settings form sheet and spilled
        // out over the sidebar; attached here it anchors to this row. Compact
        // width is unaffected: still a bottom action sheet.
        //
        // Deliberately OUTSIDE the `.disabled(…)` above: presented content
        // inherits the presenter's environment, so wrapping it the other way
        // round would let `isForgetting` grey out the dialog's own buttons.
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
