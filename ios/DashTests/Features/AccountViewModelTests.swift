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
    arguments: [
      ControlPlaneError.signInRequired, .unauthorized, .notEnrolled, .network, .decoding,
    ]
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

  @Test("signing out invokes the injected sign-out closure")
  func signOutTappedInvokesClosure() async {
    let recorder = SignOutRecorder()
    let viewModel = GatewayPickerViewModel(
      listGateways: { [] },
      connect: { _ in },
      signOut: { await recorder.record() }
    )

    await viewModel.signOutTapped()

    #expect(await recorder.count == 1)
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

private func gatewayFixture(
  gatewayId: String = "gw-1",
  subdomain: String = "mygw.relay.dash.example",
  status: String = "online"
) -> GatewayInfoDTO {
  GatewayInfoDTO(gatewayId: gatewayId, subdomain: subdomain, status: status)
}
