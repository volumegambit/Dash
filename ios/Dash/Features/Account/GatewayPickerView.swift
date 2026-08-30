import Observation
import SwiftUI

/// Exact copy constants for the account sign-in flow (Global Constraints in
/// the implementation plan — binding, verbatim).
enum AccountCopy {
  static let cpUnreachable =
    "Couldn't reach your Dash account service. Check your connection and try again."
  static let notEnrolled =
    "This gateway needs to be re-enrolled from Mission Control before app access works."
  static let emptyAccount =
    "No gateways linked to your account yet. Open Mission Control → Settings → Devices → Remote access to enroll this machine."
  static let pendingApproval =
    "This device is waiting for approval from one of your signer devices."
  /// Not one of the plan's four binding constants — used for connect
  /// failures with no designated copy (`AccountConnectError.verificationFailed`
  /// / `.installFailed`, or a raw/untyped error from the `onConnected` sink).
  static let connectFailed = "Dash couldn't finish connecting to this gateway. Try again."
}

/// Drives `GatewayPickerView`'s four-state load lifecycle and per-row connect
/// attempts. Takes plain closures (rather than `AppDependencies` directly) so
/// it's fully testable with fakes, mirroring `PairingFeature`/`SettingsFeature`.
@MainActor
@Observable
final class GatewayPickerViewModel {
  enum State: Equatable, Sendable {
    case loading
    case loaded([GatewayInfoDTO])
    case empty
    case error(String)
  }

  private(set) var state: State = .loading
  private(set) var connectingGatewayID: String?
  private(set) var isSigningOut = false
  var connectError: String?

  @ObservationIgnored private let listGateways: @Sendable () async throws -> [GatewayInfoDTO]
  @ObservationIgnored private let connect: @MainActor @Sendable (GatewayInfoDTO) async throws -> Void
  @ObservationIgnored private let signOut: @MainActor @Sendable () async -> Void

  init(
    listGateways: @escaping @Sendable () async throws -> [GatewayInfoDTO],
    connect: @escaping @MainActor @Sendable (GatewayInfoDTO) async throws -> Void,
    signOut: @escaping @MainActor @Sendable () async -> Void = {}
  ) {
    self.listGateways = listGateways
    self.connect = connect
    self.signOut = signOut
  }

  /// Loads the account's gateways. Safe to call repeatedly (e.g. from a
  /// `.task` that could re-run); always resets to `.loading` first so a
  /// slow refetch doesn't show stale content indefinitely.
  func load() async {
    state = .loading
    await refresh()
  }

  /// Re-fetches without resetting to `.loading` first, so the Retry button's
  /// tap target and the error copy stay on screen while the request is in
  /// flight rather than flashing a spinner.
  func retry() async {
    await refresh()
  }

  func connectTapped(_ gateway: GatewayInfoDTO) async {
    guard connectingGatewayID == nil else { return }
    connectError = nil
    connectingGatewayID = gateway.gatewayId
    defer { connectingGatewayID = nil }
    do {
      try await connect(gateway)
    } catch {
      connectError = Self.copy(forConnectFailure: error)
    }
  }

  func signOutTapped() async {
    guard isSigningOut == false else { return }
    isSigningOut = true
    defer { isSigningOut = false }
    await signOut()
  }

  private func refresh() async {
    do {
      let gateways = try await listGateways()
      state = gateways.isEmpty ? .empty : .loaded(gateways.sorted { $0.subdomain < $1.subdomain })
    } catch {
      // Binding: a load failure is ALWAYS `.error`, never `.empty` — an
      // unreachable control plane must not be confused with "no gateways
      // enrolled" (the web app's iPad lesson).
      state = .error(AccountCopy.cpUnreachable)
    }
  }

  private static func copy(forConnectFailure error: Error) -> String {
    switch error {
    case AccountConnectError.notEnrolled:
      return AccountCopy.notEnrolled
    case AccountConnectError.pendingApproval:
      return AccountCopy.pendingApproval
    case AccountConnectError.verificationFailed, AccountConnectError.installFailed:
      return AccountCopy.connectFailed
    default:
      break
    }
    if let controlPlaneError = error as? ControlPlaneError {
      switch controlPlaneError {
      case .signInRequired, .unauthorized, .notEnrolled, .network, .decoding:
        return AccountCopy.cpUnreachable
      }
    }
    // A raw, untyped error from the `onConnected` sink (e.g. sync-engine
    // activation failing) — treat as a connect failure rather than crash or
    // show a blank error.
    return AccountCopy.connectFailed
  }
}

struct GatewayPickerView: View {
  @Bindable var viewModel: GatewayPickerViewModel

  var body: some View {
    content
      .navigationTitle("Choose a Gateway")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            Task { await viewModel.signOutTapped() }
          } label: {
            if viewModel.isSigningOut {
              ProgressView()
            } else {
              Text("Sign Out")
            }
          }
          .disabled(viewModel.isSigningOut)
          .accessibilityIdentifier("account.signout")
        }
      }
      .accessibilityIdentifier("account.picker")
      .alert("Couldn't connect", isPresented: connectErrorPresented) {
        Button("OK") { viewModel.connectError = nil }
      } message: {
        Text(viewModel.connectError ?? "")
      }
  }

  @ViewBuilder
  private var content: some View {
    switch viewModel.state {
    case .loading:
      ProgressView("Loading your gateways")
        .frame(maxWidth: .infinity, maxHeight: .infinity)

    case .loaded(let gateways):
      List(gateways, id: \.gatewayId) { gateway in
        gatewayRow(gateway)
      }
      .listStyle(.insetGrouped)

    case .empty:
      ContentUnavailableView(
        "No Gateways Yet",
        systemImage: "server.rack",
        description: Text(AccountCopy.emptyAccount)
      )

    case .error(let message):
      VStack(spacing: 16) {
        Label(message, systemImage: "exclamationmark.triangle.fill")
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
        Button("Retry") {
          Task { await viewModel.retry() }
        }
        .buttonStyle(.borderedProminent)
        .accessibilityIdentifier("account.retry")
      }
      .padding(24)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  private func gatewayRow(_ gateway: GatewayInfoDTO) -> some View {
    Button {
      Task { await viewModel.connectTapped(gateway) }
    } label: {
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Text(gateway.subdomain)
            .font(.body.weight(.medium))
            .foregroundStyle(.primary)
          Text(gateway.status.capitalized)
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        Spacer()
        if viewModel.connectingGatewayID == gateway.gatewayId {
          ProgressView()
        } else {
          Image(systemName: "chevron.right")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.tertiary)
        }
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(viewModel.connectingGatewayID != nil)
    .accessibilityIdentifier("account.gateway.\(gateway.gatewayId)")
  }

  private var connectErrorPresented: Binding<Bool> {
    Binding(
      get: { viewModel.connectError != nil },
      set: { isPresented in
        if isPresented == false {
          viewModel.connectError = nil
        }
      }
    )
  }
}
