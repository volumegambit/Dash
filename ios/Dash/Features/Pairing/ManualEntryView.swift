import SwiftUI

struct ManualEntryView: View {
  @Environment(PairingFeature.self) private var feature
  @State private var input = ManualPairingInput()

  var body: some View {
    Form {
      Section {
        Picker("Connection", selection: $input.mode) {
          Text("Local network").tag(ManualPairingMode.lan)
          Text("Relay").tag(ManualPairingMode.relay)
        }
        .pickerStyle(.segmented)
      } header: {
        Text("Connection type")
      } footer: {
        Text(connectionHelp)
      }

      Section("Gateway") {
        TextField("Host", text: $input.host, prompt: Text("gateway.local"))
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .keyboardType(.URL)

        if input.mode == .lan {
          TextField("LAN port", text: $input.managementPort, prompt: Text("9400"))
            .keyboardType(.numberPad)
          LabeledContent("Security", value: "Pinned TLS")
        } else {
          LabeledContent("Ports", value: "443")
          LabeledContent("Security", value: "TLS")
        }
      }

      Section("Connection secrets") {
        SecureField("Mobile token", text: $input.mobileToken)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .textContentType(.oneTimeCode)
        if input.mode == .relay {
          SecureField("Relay credential", text: $input.relayCredential)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .textContentType(.oneTimeCode)
        } else {
          SecureField("Certificate SHA-256", text: $input.tlsCertificateSha256)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .textContentType(.oneTimeCode)
        }
      }

      Section {
        Button {
          Task { await feature.pair(manual: input) }
        } label: {
          Text("Connect")
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .disabled(feature.state.isWorking)
      }

      Section {
        PairingStatusView(state: feature.state)
      }
      .listRowBackground(Color.clear)
    }
    .navigationTitle("Enter manually")
    .navigationBarTitleDisplayMode(.inline)
  }

  private var connectionHelp: String {
    switch input.mode {
    case .lan:
      "Use this on the same network. Empty port uses 9400. Scan or paste the Mission Control code unless trusted local tooling supplied these values."
    case .relay:
      "Relay connections always use TLS on port 443 and require a device credential."
    }
  }
}
