import SwiftUI
import UIKit

struct SettingsView: View {
  @Environment(SettingsFeature.self) private var feature
  @Environment(AppModel.self) private var appModel
  @State private var showForgetConfirmation = false
  #if DEBUG
    @State private var showsSpeechSettings = false
  #endif
  @State private var approveDeviceViewModel: ApproveDeviceViewModel?
  @State private var didCopyPublicKey = false

  var body: some View {
    // `@Environment` hands back a plain reference; `@Bindable` is what turns an
    // @Observable into something `$`-bindable for the location Toggle.
    @Bindable var feature = feature
    // The composer Return-key preference lives in its own observable singleton
    // so the composer and this Picker can never disagree about it.
    @Bindable var composerPreferences = ComposerPreferences.shared
    return Form {
      Section("HQ") {
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
        LabeledContent("HQ ID") {
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
          // Deliberately NOT `StatusBadge`, which is a SwiftUI `Label`.
          // A `Label` in `LabeledContent`'s value slot is laid out as a
          // form-row label rather than sized to its content: it reserved
          // ~200pt of empty vertical space below "Status", pushing the rest
          // of the Connection card down (captured on the iPad simulator via
          // the Phase B launch option, and originally reported from a photo
          // of a physical iPad). `.fixedSize()` is not the fix either — it
          // collapses the title away and leaves only the glyph.
          //
          // `StatusBadge` stays correct in its own context: `OfflineBanner`
          // puts it in a plain `HStack`, where `Label` behaves.
          HStack(spacing: 4) {
            Image(systemName: feature.connectionSystemImage)
            Text(feature.connectionText)
          }
          .font(.footnote.weight(.semibold))
          .foregroundStyle(statusColor)
          .accessibilityElement(children: .combine)
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
        Toggle("Share precise location", isOn: $feature.sharePreciseLocation)
          .frame(minHeight: 44)
          .accessibilityIdentifier("settings.share-precise-location")
      } header: {
        Text("Location")
      } footer: {
        Text(
          """
          Your agent already knows your time zone and region. Turning this on \
          also shares your approximate coordinates, which are stored with the \
          conversation.
          """
        )
      }

      Section {
        Picker("Return key", selection: $composerPreferences.returnKeySends) {
          Text("New line").tag(false)
          Text("Send message").tag(true)
        }
        .frame(minHeight: 44)
        .accessibilityIdentifier("settings.return-key")
      } header: {
        Text("Composer")
      } footer: {
        Text(
          """
          What the Return key does in the message composer, on both the \
          hardware and on-screen keyboards. Cmd+Return always sends; \
          Shift+Return always inserts a new line.
          """
        )
      }

      Section {
        // Gated on the LIVE gateway's capabilities, not on the profile: a
        // gateway gains and loses `speech-v1` with its provider credentials
        // (see `AppModel.gatewayCapabilities`), so the row appears and
        // disappears with the capability rather than being permanently
        // decided at pairing time.
        if appModel.speechAvailable {
          NavigationLink {
            SpeechSettingsHost()
          } label: {
            Label("Speech", systemImage: "waveform")
          }
          .frame(minHeight: 44)
          .accessibilityIdentifier("settings.speech")
        }
      } header: {
        Text("Speech")
      } footer: {
        Text(
          appModel.speechAvailable
            ? "Dictation, read aloud, and the voice your agent speaks with."
            : "Update your HQ to use speech."
        )
        .accessibilityIdentifier(
          appModel.speechAvailable ? "settings.speech.description" : "settings.speech.unavailable"
        )
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
            "This removes this HQ's connection secrets, offline cache, drafts, and attachments from this device."
          )
        }

        if feature.isForgetting {
          HStack {
            ProgressView()
            Text("Removing HQ data")
              .foregroundStyle(.secondary)
          }
          .accessibilityElement(children: .combine)
        }
      } header: {
        Text("Device")
      } footer: {
        Text(
          "Connection secrets, offline cache, drafts, and attachments for this HQ are removed from this device."
        )
      }

      Section {
        LabeledContent("Version") {
          // Middle-dot join so the build number — the only thing that changes
          // between two OTA installs of the same marketing version — is
          // always visible next to it, which is what confirms which build is
          // actually running.
          Text(Self.versionDisplay)
            .textSelection(.enabled)
            .accessibilityIdentifier("settings.version.value")
        }
        .frame(minHeight: 44)
      } header: {
        Text("About")
      }
    }
    .accessibilityIdentifier("settings.list")
    .navigationTitle("Settings")
    // Debug-only deep link: `simctl` has no tap, so a pushed detail view is
    // unreachable from a capture run without one. The UI tests tap the row
    // like a person does. See `UITestLaunchOptions.opensSpeechSettings`.
    #if DEBUG
      .navigationDestination(isPresented: $showsSpeechSettings) { SpeechSettingsHost() }
      // Keyed on the capability, not a bare `.task`: `speech-v1` arrives from
      // an async `/health` probe (`adoptCapabilities`), so a once-on-appear
      // task can run before the row exists and leave the capture script
      // writing a Settings screenshot under the name `settings-speech`.
      .task(id: appModel.speechAvailable) {
        guard UITestLaunchOptions.opensSpeechSettings, appModel.speechAvailable else { return }
        showsSpeechSettings = true
      }
    #endif
    .alert("Settings update failed", isPresented: errorPresented) {
      Button("OK") { feature.error = nil }
    } message: {
      Text(feature.error ?? "Dash couldn't update HQ settings.")
    }
    .sheet(isPresented: approveDeviceSheetPresented) {
      if let approveDeviceViewModel {
        ApproveDeviceView(viewModel: approveDeviceViewModel)
      }
    }
  }

  /// The marketing version and build number as `1.2.3 (456)`, read from the
  /// app's Info.plist. The build number is what distinguishes two OTA installs
  /// of the same version, so it is always shown — this row exists to confirm
  /// which build is actually running on the device.
  static var versionDisplay: String {
    let info = Bundle.main.infoDictionary
    let short = info?["CFBundleShortVersionString"] as? String ?? "—"
    let build = info?["CFBundleVersion"] as? String ?? "—"
    return "\(short) (\(build))"
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
