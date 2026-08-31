import Observation
import SwiftUI

/// Exact copy constants for the scan-to-approve flow (Task 6 of the
/// signer-device plan). Mirrors `AccountCopy`'s "binding, verbatim" role in
/// `GatewayPickerView.swift`.
enum ApproveDeviceCopy {
  static let invalidPayload = "That's not a Dash approval code."
  static let expired = "This code has expired. Ask the device to try again."
  /// `403` on `POST /v1/approvals/:id/decision` (`ControlPlaneError.forbidden`):
  /// the signature didn't verify, or this signer isn't registered under the
  /// signed-in account — Task 3 deliberately makes those indistinguishable,
  /// so this copy stays generic rather than guessing which one happened.
  static let forbidden =
    "Dash couldn't confirm this device is allowed to approve requests. Try again, or reconnect a gateway from Settings."
  static let genericFailure = "Dash couldn't process this approval. Try again."
  static let approved = "Device approved."
  static let denied = "Device request denied."
  /// Substituted for `ApprovalRequestDTO.deviceLabel` when the web pairing
  /// that requested approval was minted without a label.
  static let genericDeviceLabel = "a device"

  static func confirmTitle(deviceLabel: String?, gatewayId: String) -> String {
    "Allow \"\(deviceLabel ?? genericDeviceLabel)\" to access \(gatewayId)?"
  }
}

/// The prefix a scanned QR payload must carry to be treated as a Dash
/// approval code — MUST stay in sync with the exact string
/// `apps/web/src/ui/PendingApproval.tsx` encodes into its QR
/// (`dash-approve:v1:<approvalId>`).
private let approvalQRPrefix = "dash-approve:v1:"

/// Drives one scan-to-approve attempt: scan a `dash-approve:v1:<approvalId>`
/// code, fetch the pending approval, let the user confirm or deny, then post
/// a signed decision. Takes plain closures rather than `ControlPlaneClient`/
/// `SignerIdentity` directly (mirroring `GatewayPickerViewModel`/
/// `AccountConnectFeature`) so it's fully testable with fakes.
@MainActor
@Observable
final class ApproveDeviceViewModel {
  enum State: Equatable, Sendable {
    case scanning
    case fetching
    case confirming(ApprovalRequestDTO)
    case deciding(ApprovalRequestDTO, decision: String)
    case result(String)
    case failed(String)
  }

  private(set) var state: State = .scanning

  let scanner: any QRScanning

  @ObservationIgnored
  private let fetchApproval: @MainActor @Sendable (String) async throws -> ApprovalRequestDTO
  @ObservationIgnored
  private let resolveSignerId: @MainActor @Sendable () async throws -> String
  /// Unconditionally re-registers this device's signer (bypassing whatever
  /// `resolveSignerId` cached) — the recovery half of the retry-on-403 story.
  /// See `decide(_:)`'s doc comment and `AccountFeatureFactory.
  /// makeApproveDeviceViewModel`'s.
  @ObservationIgnored
  private let registerSigner: @MainActor @Sendable () async throws -> String
  @ObservationIgnored
  private let sign: @MainActor @Sendable (String, String, String) async throws -> String
  @ObservationIgnored
  private let postDecision: @MainActor @Sendable (String, String, String, String) async throws -> Void

  init(
    scanner: any QRScanning,
    fetchApproval: @escaping @MainActor @Sendable (String) async throws -> ApprovalRequestDTO,
    resolveSignerId: @escaping @MainActor @Sendable () async throws -> String,
    registerSigner: @escaping @MainActor @Sendable () async throws -> String,
    sign: @escaping @MainActor @Sendable (String, String, String) async throws -> String,
    postDecision: @escaping @MainActor @Sendable (String, String, String, String) async throws -> Void
  ) {
    self.scanner = scanner
    self.fetchApproval = fetchApproval
    self.resolveSignerId = resolveSignerId
    self.registerSigner = registerSigner
    self.sign = sign
    self.postDecision = postDecision
  }

  /// Parses a scanned payload and, if it carries the Dash approval prefix,
  /// fetches the pending approval it names. Anything else (a stray QR from
  /// some other app, a truncated/garbled scan) shows the invalid-payload
  /// copy rather than attempting a lookup with a nonsense id.
  func handleScanned(_ payload: String) async {
    guard payload.hasPrefix(approvalQRPrefix) else {
      state = .failed(ApproveDeviceCopy.invalidPayload)
      return
    }
    let approvalId = String(payload.dropFirst(approvalQRPrefix.count))
    guard approvalId.isEmpty == false else {
      state = .failed(ApproveDeviceCopy.invalidPayload)
      return
    }
    state = .fetching
    do {
      let approval = try await fetchApproval(approvalId)
      state = .confirming(approval)
    } catch {
      state = .failed(Self.copy(for: error))
    }
  }

  func approve() async {
    await decide("approve")
  }

  func deny() async {
    await decide("deny")
  }

  /// Lets the user scan another code after an error, without dismissing and
  /// re-presenting this whole screen.
  func retry() {
    state = .scanning
  }

  /// Defense-in-depth against a stale, no-longer-recognized `signerId`:
  /// `AppModel.signOutOfAccount()` wipes this device's signer identity on
  /// sign-out so that scenario shouldn't normally arise, but a `403` here
  /// (the control plane's "signature didn't verify or signerId isn't
  /// registered under this account" response) is unconditionally
  /// re-registered and retried EXACTLY ONCE before giving up — self-healing
  /// a stale id rather than permanently bricking "Approve a device" on this
  /// device until reinstall. A second `403` (or any other error) surfaces
  /// normally.
  private func decide(_ decision: String) async {
    guard case .confirming(let approval) = state else { return }
    state = .deciding(approval, decision: decision)
    do {
      let signerId = try await resolveSignerId()
      do {
        try await signAndPostDecision(approval: approval, decision: decision, signerId: signerId)
      } catch ControlPlaneError.forbidden {
        let freshSignerId = try await registerSigner()
        try await signAndPostDecision(
          approval: approval,
          decision: decision,
          signerId: freshSignerId
        )
      }
      state = .result(decision == "approve" ? ApproveDeviceCopy.approved : ApproveDeviceCopy.denied)
    } catch {
      state = .failed(Self.copy(for: error))
    }
  }

  private func signAndPostDecision(
    approval: ApprovalRequestDTO,
    decision: String,
    signerId: String
  ) async throws {
    let signature = try await sign(approval.approvalId, approval.pairingId, decision)
    try await postDecision(approval.approvalId, decision, signerId, signature)
  }

  private static func copy(for error: Error) -> String {
    switch error {
    case ControlPlaneError.expired:
      return ApproveDeviceCopy.expired
    case ControlPlaneError.forbidden:
      return ApproveDeviceCopy.forbidden
    default:
      return ApproveDeviceCopy.genericFailure
    }
  }
}

/// Presented from `SettingsView`'s "Approve a device" row. Reuses
/// `QRScannerView`/`ScanCoordinator` (retained since Task 7 of the iOS
/// account sign-in plan for exactly this) as its first product consumer —
/// camera-denied UX is entirely `QRScannerView`'s own, this view adds nothing
/// on top of it.
struct ApproveDeviceView: View {
  @Bindable var viewModel: ApproveDeviceViewModel
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      content
        .navigationTitle("Approve a device")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            Button("Close") { dismiss() }
          }
        }
    }
  }

  @ViewBuilder
  private var content: some View {
    switch viewModel.state {
    case .scanning:
      QRScannerView(
        scanner: viewModel.scanner,
        onScanned: { payload in
          Task { await viewModel.handleScanned(payload) }
        },
        onCancel: { dismiss() }
      )

    case .fetching:
      ProgressView("Loading request")
        .frame(maxWidth: .infinity, maxHeight: .infinity)

    case .confirming(let approval):
      confirmContent(approval)

    case .deciding:
      ProgressView()
        .frame(maxWidth: .infinity, maxHeight: .infinity)

    case .result(let message):
      resultContent(message)

    case .failed(let message):
      failedContent(message)
    }
  }

  private func confirmContent(_ approval: ApprovalRequestDTO) -> some View {
    VStack(spacing: 20) {
      Image(systemName: "checkmark.shield")
        .font(.system(size: 48))
        .foregroundStyle(.secondary)
      Text(
        ApproveDeviceCopy.confirmTitle(
          deviceLabel: approval.deviceLabel,
          gatewayId: approval.gatewayId
        )
      )
      .font(.title3.weight(.semibold))
      .multilineTextAlignment(.center)

      HStack(spacing: 16) {
        Button("Deny", role: .destructive) {
          Task { await viewModel.deny() }
        }
        .buttonStyle(.bordered)
        .frame(minWidth: 100, minHeight: 44)
        .accessibilityIdentifier("account.deny")

        Button("Approve") {
          Task { await viewModel.approve() }
        }
        .buttonStyle(.borderedProminent)
        .frame(minWidth: 100, minHeight: 44)
        .accessibilityIdentifier("account.approve")
      }
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func resultContent(_ message: String) -> some View {
    VStack(spacing: 16) {
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 48))
        .foregroundStyle(.green)
      Text(message)
        .font(.headline)
        .multilineTextAlignment(.center)
      Button("Done") { dismiss() }
        .buttonStyle(.borderedProminent)
        .frame(minHeight: 44)
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func failedContent(_ message: String) -> some View {
    VStack(spacing: 16) {
      Label(message, systemImage: "exclamationmark.triangle.fill")
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
      Button("Try Again") { viewModel.retry() }
        .buttonStyle(.borderedProminent)
        .frame(minHeight: 44)
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
