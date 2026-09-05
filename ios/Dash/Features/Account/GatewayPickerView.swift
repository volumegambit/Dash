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
  /// Guards `load()`/`retry()` against overlapping requests — without it, a
  /// slow stale request finishing after a fast fresh one can clobber the
  /// fresh result (or a fresh `.error` can stomp a fresh `.loaded`).
  private(set) var isRefreshing = false
  var connectError: String?

  @ObservationIgnored private let listGateways: @Sendable () async throws -> [GatewayInfoDTO]
  @ObservationIgnored private let connect: @MainActor @Sendable (GatewayInfoDTO) async throws -> Void
  @ObservationIgnored private let signOut: @MainActor @Sendable () async -> Void
  /// Called when the account session itself turns out to be unusable
  /// (`ControlPlaneError.signInRequired` from either a load or a connect
  /// attempt) as well as after an explicit sign-out completes — either way,
  /// the presenting nav layer should fall back to `SignInView`. The cached
  /// account token is memory-only with no refresh path, so once it expires
  /// there's nothing this screen's own Retry button can do.
  @ObservationIgnored private let onSignedOut: @MainActor @Sendable () -> Void

  init(
    listGateways: @escaping @Sendable () async throws -> [GatewayInfoDTO],
    connect: @escaping @MainActor @Sendable (GatewayInfoDTO) async throws -> Void,
    signOut: @escaping @MainActor @Sendable () async -> Void = {},
    onSignedOut: @escaping @MainActor @Sendable () -> Void = {}
  ) {
    self.listGateways = listGateways
    self.connect = connect
    self.signOut = signOut
    self.onSignedOut = onSignedOut
  }

  /// Loads the account's gateways. Safe to call repeatedly (e.g. from a
  /// `.task` that could re-run); always resets to `.loading` first so a
  /// slow refetch doesn't show stale content indefinitely. No-ops while a
  /// load/retry is already in flight.
  func load() async {
    guard isRefreshing == false else { return }
    state = .loading
    await refresh()
  }

  /// Re-fetches without resetting to `.loading` first, so the Retry button's
  /// tap target and the error copy stay on screen (with the button disabled
  /// via `isRefreshing`) while the request is in flight rather than flashing
  /// a spinner. No-ops while a load/retry is already in flight, so rapid
  /// double-taps issue exactly one request.
  func retry() async {
    guard isRefreshing == false else { return }
    await refresh()
  }

  func connectTapped(_ gateway: GatewayInfoDTO) async {
    guard connectingGatewayID == nil else { return }
    connectError = nil
    connectingGatewayID = gateway.gatewayId
    defer { connectingGatewayID = nil }
    do {
      try await connect(gateway)
    } catch ControlPlaneError.signInRequired {
      onSignedOut()
    } catch {
      connectError = Self.copy(forConnectFailure: error)
    }
  }

  func signOutTapped() async {
    guard isSigningOut == false else { return }
    isSigningOut = true
    defer { isSigningOut = false }
    await signOut()
    onSignedOut()
  }

  private func refresh() async {
    isRefreshing = true
    defer { isRefreshing = false }
    do {
      let gateways = try await listGateways()
      state = gateways.isEmpty ? .empty : .loaded(gateways.sorted { $0.subdomain < $1.subdomain })
    } catch ControlPlaneError.signInRequired {
      onSignedOut()
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
      case .signInRequired:
        // Defense in depth: `connectTapped` already intercepts this case
        // before reaching here (see the `catch ControlPlaneError.signInRequired`
        // clause above) and routes it through `onSignedOut()` instead. Kept
        // in this exhaustive switch so a future refactor that bypasses that
        // early catch still gets a sane copy instead of a compiler error.
        return AccountCopy.cpUnreachable
      case .unauthorized, .notEnrolled, .network, .decoding, .forbidden, .expired:
        // `.forbidden`/`.expired` are `POST /v1/approvals/:id/decision`-only
        // outcomes (Task 3) — `connect(to:)`'s own control-plane calls
        // (`listGateways`/`createPairing`) never produce them. Kept in this
        // exhaustive switch for the same defense-in-depth reason as
        // `.signInRequired` above; Task 6 owns the dedicated
        // "expired"/"forbidden" copy for the approval-decision surface
        // itself.
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
      // `.contain` makes this modifier chain's target its own accessibility
      // container (so `account.picker` itself stays queryable) WITHOUT
      // combining or overriding descendants' own identifiers — without it,
      // states whose root isn't already a container (`.error`'s plain
      // `VStack`, `.empty`'s `ContentUnavailableView`) leak this identifier
      // onto every accessible child instead, stomping e.g. `account.retry`.
      .accessibilityElement(children: .contain)
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
      // Matches `SignInView`'s 520pt measure. These two are adjacent screens
      // in the same pre-connection flow, and this one stretched a single
      // gateway row across ~790pt on an 11-inch iPad while the other was
      // already constrained — the inconsistency is what reads as unfinished,
      // more than either width on its own.
      .frame(maxWidth: 520)
      .frame(maxWidth: .infinity)
      // A gateway enrolled in Mission Control after this list loaded is
      // otherwise invisible until the app is relaunched. `retry()` is
      // re-entrancy-guarded, so an over-eager pull issues exactly one request.
      .refreshable { await viewModel.retry() }

    case .empty:
      ContentUnavailableView {
        Label("No Gateways Yet", systemImage: "server.rack")
      } description: {
        Text(AccountCopy.emptyAccount)
      } actions: {
        // The empty-state copy sends the user off to Mission Control to enroll
        // a machine; this is how they get back to a populated list without
        // relaunching. There is no pull-to-refresh here to fall back on —
        // `ContentUnavailableView` is not a scroll view.
        Button {
          Task { await viewModel.retry() }
        } label: {
          if viewModel.isRefreshing {
            ProgressView()
          } else {
            Text("Refresh")
          }
        }
        .buttonStyle(.borderedProminent)
        .frame(minWidth: 44, minHeight: 44)
        .disabled(viewModel.isRefreshing)
        .accessibilityIdentifier("account.refresh")
      }

    case .error(let message):
      VStack(spacing: 16) {
        Label(message, systemImage: "exclamationmark.triangle.fill")
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
        Button {
          Task { await viewModel.retry() }
        } label: {
          if viewModel.isRefreshing {
            ProgressView()
          } else {
            Text("Retry")
          }
        }
        .buttonStyle(.borderedProminent)
        .disabled(viewModel.isRefreshing)
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
