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
          TextField("Management port", text: $input.managementPort, prompt: Text("9300"))
            .keyboardType(.numberPad)
          TextField("Chat port", text: $input.chatPort, prompt: Text("9200"))
            .keyboardType(.numberPad)
          Toggle("Use secure connection", isOn: $input.secure)
        } else {
          LabeledContent("Ports", value: "443")
          LabeledContent("Security", value: "TLS")
        }
      }

      Section("Connection secrets") {
        SecureField("Management token", text: $input.managementToken)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
        SecureField("Chat token", text: $input.chatToken)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
        if input.mode == .relay {
          SecureField("Relay credential", text: $input.relayCredential)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
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
      "Use this when the phone and gateway are on the same network. Empty ports use 9300 and 9200."
    case .relay:
      "Relay connections always use TLS on port 443 and require a device credential."
    }
  }
}
