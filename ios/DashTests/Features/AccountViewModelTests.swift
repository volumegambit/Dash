import Foundation
import Testing

@testable import Dash

@Suite("Gateway picker view model")
@MainActor
struct GatewayPickerViewModelTests {
  @Test("a load failure surfaces .error with the CP-unreachable copy, never .empty")
  func loadFailureNeverShowsEmpty() async {
    let viewModel = GatewayPickerViewModel(
      listGateways: { throw ControlPlaneError.network },
      connect: { _ in }
    )

    await viewModel.load()

    guard case .error(let message) = viewModel.state else {
      Issue.record("expected .error, got \(viewModel.state)")
      return
    }
    #expect(message == AccountCopy.cpUnreachable)
  }

  @Test("an empty gateway list surfaces .empty, not .error")
  func emptyListShowsEmptyState() async {
    let viewModel = GatewayPickerViewModel(
      listGateways: { [] },
      connect: { _ in }
    )

    await viewModel.load()

    #expect(viewModel.state == .empty)
  }

  @Test("a non-empty gateway list surfaces .loaded sorted by subdomain")
  func gatewaysSortedBySubdomain() async {
    let unsorted = [
      gatewayFixture(gatewayId: "b", subdomain: "zzz.relay.dash.example"),
      gatewayFixture(gatewayId: "a", subdomain: "aaa.relay.dash.example"),
      gatewayFixture(gatewayId: "c", subdomain: "mmm.relay.dash.example"),
    ]
    let viewModel = GatewayPickerViewModel(
      listGateways: { unsorted },
      connect: { _ in }
    )

    await viewModel.load()

    guard case .loaded(let gateways) = viewModel.state else {
      Issue.record("expected .loaded, got \(viewModel.state)")
      return
    }
    #expect(gateways.map(\.subdomain) == [
      "aaa.relay.dash.example", "mmm.relay.dash.example", "zzz.relay.dash.example",
    ])
  }

  @Test("AccountConnectError.notEnrolled maps to the exact re-enroll copy")
  func notEnrolledMapsToReEnrollCopy() async {
    let viewModel = GatewayPickerViewModel(
      listGateways: { [] },
      connect: { _ in throw AccountConnectError.notEnrolled }
    )

    await viewModel.connectTapped(gatewayFixture())

    #expect(viewModel.connectError == AccountCopy.notEnrolled)
  }

  @Test("AccountConnectError.pendingApproval maps to the exact signer-pending copy")
  func pendingApprovalMapsToSignerPendingCopy() async {
    let viewModel = GatewayPickerViewModel(
      listGateways: { [] },
      connect: { _ in throw AccountConnectError.pendingApproval }
    )

    await viewModel.connectTapped(gatewayFixture())

    #expect(viewModel.connectError == AccountCopy.pendingApproval)
  }

  @Test(
    "AccountConnectError.verificationFailed/.installFailed map to the connect-failure copy",
    arguments: [AccountConnectError.verificationFailed, AccountConnectError.installFailed]
  )
  func verificationOrInstallFailureMapsToConnectFailedCopy(error: AccountConnectError) async {
    let viewModel = GatewayPickerViewModel(
      listGateways: { [] },
      connect: { _ in throw error }
    )

    await viewModel.connectTapped(gatewayFixture())

    #expect(viewModel.connectError == AccountCopy.connectFailed)
  }

  @Test(
    "ControlPlaneError variants during connect map to the CP-unreachable copy",
    arguments: [ControlPlaneError.unauthorized, .notEnrolled, .network, .decoding]
  )
  func controlPlaneErrorDuringConnectMapsToCPUnreachable(error: ControlPlaneError) async {
    let viewModel = GatewayPickerViewModel(
      listGateways: { [] },
      connect: { _ in throw error }
    )

    await viewModel.connectTapped(gatewayFixture())

    #expect(viewModel.connectError == AccountCopy.cpUnreachable)
  }

  @Test("a raw, untyped connect failure (onConnected throwing) is treated as connect-failure, not a crash")
  func rawConnectFailureMapsToGenericCopy() async {
    struct RawFailure: Error {}
    let viewModel = GatewayPickerViewModel(
      listGateways: { [] },
      connect: { _ in throw RawFailure() }
    )

    await viewModel.connectTapped(gatewayFixture())

    #expect(viewModel.connectError == AccountCopy.connectFailed)
  }

  @Test("retry re-fetches gateways and can recover from a prior error")
  func retryRefetches() async {
    let callCount = Counter()
    let viewModel = GatewayPickerViewModel(
      listGateways: {
        let count = await callCount.increment()
        if count == 1 { throw ControlPlaneError.network }
        return [gatewayFixture()]
      },
      connect: { _ in }
    )

    await viewModel.load()
    guard case .error = viewModel.state else {
      Issue.record("expected initial .error, got \(viewModel.state)")
      return
    }

    await viewModel.retry()

    guard case .loaded(let gateways) = viewModel.state else {
      Issue.record("expected .loaded after retry, got \(viewModel.state)")
      return
    }
    #expect(gateways == [gatewayFixture()])
    #expect(await callCount.value == 2)
  }

  @Test("retry from the empty state re-fetches and shows a newly enrolled gateway")
  func emptyStateRefreshPicksUpANewGateway() async {
    // The `.empty` copy tells the user to go enroll a machine in Mission
    // Control. Without a refresh affordance there, the only way back is to
    // kill the app — so `retry()` must work from `.empty`, not just `.error`.
    let callCount = Counter()
    let viewModel = GatewayPickerViewModel(
      listGateways: {
        let count = await callCount.increment()
        return count == 1 ? [] : [gatewayFixture()]
      },
      connect: { _ in }
    )

    await viewModel.load()
    #expect(viewModel.state == .empty)

    await viewModel.retry()

    #expect(viewModel.state == .loaded([gatewayFixture()]))
    #expect(await callCount.value == 2)
  }

  @Test("an empty-state refresh that fails surfaces .error rather than staying silently empty")
  func emptyStateRefreshFailureSurfacesError() async {
    let callCount = Counter()
    let viewModel = GatewayPickerViewModel(
      listGateways: {
        let count = await callCount.increment()
        if count == 1 { return [] }
        throw ControlPlaneError.network
      },
      connect: { _ in }
    )

    await viewModel.load()
    #expect(viewModel.state == .empty)

    await viewModel.retry()

    #expect(viewModel.state == .error(AccountCopy.cpUnreachable))
  }

  @Test("signing out invokes the injected sign-out closure, then signals the nav layer")
  func signOutTappedInvokesClosureThenSignalsSignedOut() async {
    let signOutRecorder = SignOutRecorder()
    let signedOutRecorder = SignedOutRecorder()
    let viewModel = GatewayPickerViewModel(
      listGateways: { [] },
      connect: { _ in },
      signOut: { await signOutRecorder.record() },
      onSignedOut: { signedOutRecorder.record() }
    )

    await viewModel.signOutTapped()

    #expect(await signOutRecorder.count == 1)
    #expect(signedOutRecorder.count == 1)
  }

  @Test("a signInRequired load failure signals the nav layer instead of an unrecoverable Retry loop")
  func signInRequiredDuringLoadSignalsSignedOut() async {
    let signedOutRecorder = SignedOutRecorder()
    let viewModel = GatewayPickerViewModel(
      listGateways: { throw ControlPlaneError.signInRequired },
      connect: { _ in },
      onSignedOut: { signedOutRecorder.record() }
    )

    await viewModel.load()

    #expect(signedOutRecorder.count == 1)
  }

  @Test("a signInRequired connect failure signals the nav layer instead of a CP-unreachable dead end")
  func signInRequiredDuringConnectSignalsSignedOut() async {
    let signedOutRecorder = SignedOutRecorder()
    let viewModel = GatewayPickerViewModel(
      listGateways: { [] },
      connect: { _ in throw ControlPlaneError.signInRequired },
      onSignedOut: { signedOutRecorder.record() }
    )

    await viewModel.connectTapped(gatewayFixture())

    #expect(signedOutRecorder.count == 1)
    #expect(viewModel.connectError == nil)
  }

  @Test("rapid double-retry issues exactly one in-flight load")
  func rapidDoubleRetryIssuesOneLoad() async {
    let box = ViewModelBox()
    let callCount = Counter()
    let viewModel = GatewayPickerViewModel(
      listGateways: {
        let count = await callCount.increment()
        if count == 1 {
          // A genuinely reentrant second call, fired while the FIRST
          // `listGateways()` is still suspended awaiting `callCount`'s actor
          // hop above — this is the deterministic equivalent of "a rapid
          // double-tap on Retry": `isRefreshing` was already flipped `true`
          // synchronously before this call started, so this nested `retry()`
          // must see it and no-op rather than issuing a second request.
          await box.viewModel?.retry()
        }
        return [gatewayFixture()]
      },
      connect: { _ in }
    )
    box.viewModel = viewModel

    await viewModel.load()

    #expect(await callCount.value == 1)
    guard case .loaded(let gateways) = viewModel.state else {
      Issue.record("expected .loaded, got \(viewModel.state)")
      return
    }
    #expect(gateways == [gatewayFixture()])
  }
}

// MARK: - Fakes

private actor Counter {
  private(set) var value = 0

  func increment() -> Int {
    value += 1
    return value
  }
}

private actor SignOutRecorder {
  private(set) var count = 0

  func record() {
    count += 1
  }
}

/// `onSignedOut` is `@MainActor @Sendable () -> Void` (synchronous), so a
/// plain `@MainActor` class records it without the async/await ceremony an
/// actor would need — the test itself already runs on `@MainActor`.
@MainActor
private final class SignedOutRecorder {
  private(set) var count = 0

  func record() {
    count += 1
  }
}

/// Lets a fake closure reach back into the view model it's constructing —
/// used to fire a genuinely reentrant second call from inside the first
/// call's in-flight fake work, deterministically exercising a re-entrancy
/// guard without depending on task-scheduling timing. `@unchecked Sendable`
/// because it's captured by `listGateways`'s plain `@Sendable` closure type
/// (not a `@MainActor`-typed one); only ever touched from `@MainActor` test
/// code in practice.
@MainActor
private final class ViewModelBox: @unchecked Sendable {
  weak var viewModel: GatewayPickerViewModel?
}

private func gatewayFixture(
  gatewayId: String = "gw-1",
  subdomain: String = "mygw.relay.dash.example",
  status: String = "online",
  publicKey: String = "public-key-1"
) -> GatewayInfoDTO {
  GatewayInfoDTO(
    gatewayId: gatewayId,
    subdomain: subdomain,
    status: status,
    publicKey: publicKey
  )
}
