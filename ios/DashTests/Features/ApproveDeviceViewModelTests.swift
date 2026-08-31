import AVFoundation
import Foundation
import Testing

@testable import Dash

private struct FetchFailure: Error, Sendable {}

/// A `QRScanning` stub satisfying `ApproveDeviceViewModel`'s init — none of
/// these tests drive scanning through the scanner itself (they call
/// `handleScanned(_:)` directly, mirroring how `ApproveDeviceView` invokes it
/// from `QRScannerView`'s `onScanned`), so this never needs to do anything.
private actor NeverScans: QRScanning {
  nonisolated let previewSource: QRScannerPreviewSource? = nil
  func authorizationStatus() -> AVAuthorizationStatus { .notDetermined }
  func requestAccess() async -> Bool { false }
  func scan() async throws -> String { throw QRScannerError.stopped }
  func stop() {}
}

private func fixtureApproval(
  approvalId: String = "approval-1",
  pairingId: String = "pairing-1",
  gatewayId: String = "gw-approve",
  deviceLabel: String? = "Chrome on MacBook",
  expiresAt: Int = 1_750_000_300_000
) -> ApprovalRequestDTO {
  ApprovalRequestDTO(
    approvalId: approvalId,
    pairingId: pairingId,
    gatewayId: gatewayId,
    deviceLabel: deviceLabel,
    expiresAt: expiresAt
  )
}

@MainActor
private final class SignCall {
  var calls: [(approvalId: String, pairingId: String, decision: String)] = []
}

@MainActor
private final class DecisionCall {
  var calls: [(approvalId: String, decision: String, signerId: String, signature: String)] = []
}

@Suite("Approve device view model")
@MainActor
struct ApproveDeviceViewModelTests {
  @Test("a valid dash-approve:v1: payload fetches the approval and shows it for confirmation")
  func validPayloadFetchesAndConfirms() async throws {
    let approval = fixtureApproval()
    var fetchedIDs: [String] = []
    let viewModel = ApproveDeviceViewModel(
      scanner: NeverScans(),
      fetchApproval: { id in
        fetchedIDs.append(id)
        return approval
      },
      resolveSignerId: { "signer-1" },
      sign: { _, _, _ in "sig" },
      postDecision: { _, _, _, _ in }
    )

    await viewModel.handleScanned("dash-approve:v1:approval-1")

    #expect(fetchedIDs == ["approval-1"])
    #expect(viewModel.state == .confirming(approval))
  }

  @Test("a payload without the dash-approve:v1: prefix is rejected without fetching")
  func invalidPrefixIsRejected() async throws {
    var fetchCount = 0
    let viewModel = ApproveDeviceViewModel(
      scanner: NeverScans(),
      fetchApproval: { _ in
        fetchCount += 1
        return fixtureApproval()
      },
      resolveSignerId: { "signer-1" },
      sign: { _, _, _ in "sig" },
      postDecision: { _, _, _, _ in }
    )

    await viewModel.handleScanned("https://example.com/not-a-dash-code")

    #expect(fetchCount == 0)
    #expect(viewModel.state == .failed(ApproveDeviceCopy.invalidPayload))
  }

  @Test("a payload with the prefix but nothing after it is also rejected as invalid")
  func emptyApprovalIDIsRejected() async throws {
    var fetchCount = 0
    let viewModel = ApproveDeviceViewModel(
      scanner: NeverScans(),
      fetchApproval: { _ in
        fetchCount += 1
        return fixtureApproval()
      },
      resolveSignerId: { "signer-1" },
      sign: { _, _, _ in "sig" },
      postDecision: { _, _, _, _ in }
    )

    await viewModel.handleScanned("dash-approve:v1:")

    #expect(fetchCount == 0)
    #expect(viewModel.state == .failed(ApproveDeviceCopy.invalidPayload))
  }

  @Test("ControlPlaneError.expired while fetching surfaces the exact expired copy")
  func fetchExpiredSurfacesExpiredCopy() async throws {
    let viewModel = ApproveDeviceViewModel(
      scanner: NeverScans(),
      fetchApproval: { _ in throw ControlPlaneError.expired },
      resolveSignerId: { "signer-1" },
      sign: { _, _, _ in "sig" },
      postDecision: { _, _, _, _ in }
    )

    await viewModel.handleScanned("dash-approve:v1:approval-1")

    #expect(viewModel.state == .failed(ApproveDeviceCopy.expired))
  }

  @Test("an untyped fetch failure surfaces the generic failure copy")
  func fetchGenericFailureSurfacesGenericCopy() async throws {
    let viewModel = ApproveDeviceViewModel(
      scanner: NeverScans(),
      fetchApproval: { _ in throw FetchFailure() },
      resolveSignerId: { "signer-1" },
      sign: { _, _, _ in "sig" },
      postDecision: { _, _, _, _ in }
    )

    await viewModel.handleScanned("dash-approve:v1:approval-1")

    #expect(viewModel.state == .failed(ApproveDeviceCopy.genericFailure))
  }

  @Test("approve resolves the signer id, signs the exact approvalId/pairingId/decision, and posts it")
  func approvePostsDecisionWithComposedSignature() async throws {
    let approval = fixtureApproval(approvalId: "approval-42", pairingId: "pairing-42")
    let signCall = SignCall()
    let decisionCall = DecisionCall()
    let viewModel = ApproveDeviceViewModel(
      scanner: NeverScans(),
      fetchApproval: { _ in approval },
      resolveSignerId: { "signer-42" },
      sign: { approvalId, pairingId, decision in
        signCall.calls.append((approvalId, pairingId, decision))
        return "signature-42"
      },
      postDecision: { approvalId, decision, signerId, signature in
        decisionCall.calls.append((approvalId, decision, signerId, signature))
      }
    )
    await viewModel.handleScanned("dash-approve:v1:approval-42")

    await viewModel.approve()

    #expect(signCall.calls.count == 1)
    #expect(signCall.calls.first?.approvalId == "approval-42")
    #expect(signCall.calls.first?.pairingId == "pairing-42")
    #expect(signCall.calls.first?.decision == "approve")
    #expect(decisionCall.calls.count == 1)
    #expect(decisionCall.calls.first?.approvalId == "approval-42")
    #expect(decisionCall.calls.first?.decision == "approve")
    #expect(decisionCall.calls.first?.signerId == "signer-42")
    #expect(decisionCall.calls.first?.signature == "signature-42")
    #expect(viewModel.state == .result(ApproveDeviceCopy.approved))
  }

  @Test("deny signs and posts the 'deny' decision instead of 'approve'")
  func denyPostsDenyDecision() async throws {
    let approval = fixtureApproval()
    let signCall = SignCall()
    let decisionCall = DecisionCall()
    let viewModel = ApproveDeviceViewModel(
      scanner: NeverScans(),
      fetchApproval: { _ in approval },
      resolveSignerId: { "signer-1" },
      sign: { approvalId, pairingId, decision in
        signCall.calls.append((approvalId, pairingId, decision))
        return "signature-1"
      },
      postDecision: { approvalId, decision, signerId, signature in
        decisionCall.calls.append((approvalId, decision, signerId, signature))
      }
    )
    await viewModel.handleScanned("dash-approve:v1:approval-1")

    await viewModel.deny()

    #expect(signCall.calls.first?.decision == "deny")
    #expect(decisionCall.calls.first?.decision == "deny")
    #expect(viewModel.state == .result(ApproveDeviceCopy.denied))
  }

  @Test("resolveSignerId failing during approve surfaces the generic failure copy, never signs or posts")
  func resolveSignerIdFailureNeverSignsOrPosts() async throws {
    var signCount = 0
    var postCount = 0
    let viewModel = ApproveDeviceViewModel(
      scanner: NeverScans(),
      fetchApproval: { _ in fixtureApproval() },
      resolveSignerId: { throw FetchFailure() },
      sign: { _, _, _ in
        signCount += 1
        return "sig"
      },
      postDecision: { _, _, _, _ in postCount += 1 }
    )
    await viewModel.handleScanned("dash-approve:v1:approval-1")

    await viewModel.approve()

    #expect(signCount == 0)
    #expect(postCount == 0)
    #expect(viewModel.state == .failed(ApproveDeviceCopy.genericFailure))
  }

  @Test("postDecision's 410 maps to the exact expired copy")
  func postDecisionExpiredMapsToExpiredCopy() async throws {
    let viewModel = ApproveDeviceViewModel(
      scanner: NeverScans(),
      fetchApproval: { _ in fixtureApproval() },
      resolveSignerId: { "signer-1" },
      sign: { _, _, _ in "sig" },
      postDecision: { _, _, _, _ in throw ControlPlaneError.expired }
    )
    await viewModel.handleScanned("dash-approve:v1:approval-1")

    await viewModel.approve()

    #expect(viewModel.state == .failed(ApproveDeviceCopy.expired))
  }

  @Test("postDecision's 403 maps to the distinct forbidden copy")
  func postDecisionForbiddenMapsToForbiddenCopy() async throws {
    let viewModel = ApproveDeviceViewModel(
      scanner: NeverScans(),
      fetchApproval: { _ in fixtureApproval() },
      resolveSignerId: { "signer-1" },
      sign: { _, _, _ in "sig" },
      postDecision: { _, _, _, _ in throw ControlPlaneError.forbidden }
    )
    await viewModel.handleScanned("dash-approve:v1:approval-1")

    await viewModel.approve()

    #expect(viewModel.state == .failed(ApproveDeviceCopy.forbidden))
    #expect(ApproveDeviceCopy.forbidden != ApproveDeviceCopy.expired)
  }

  @Test("retry() returns to .scanning after a failure so the user can scan again")
  func retryReturnsToScanning() async throws {
    let viewModel = ApproveDeviceViewModel(
      scanner: NeverScans(),
      fetchApproval: { _ in throw FetchFailure() },
      resolveSignerId: { "signer-1" },
      sign: { _, _, _ in "sig" },
      postDecision: { _, _, _, _ in }
    )
    await viewModel.handleScanned("not-a-dash-code")
    #expect(viewModel.state == .failed(ApproveDeviceCopy.invalidPayload))

    viewModel.retry()

    #expect(viewModel.state == .scanning)
  }

  @Test("the confirm title falls back to a generic device label when deviceLabel is nil")
  func confirmTitleFallsBackForNilDeviceLabel() {
    let title = ApproveDeviceCopy.confirmTitle(deviceLabel: nil, gatewayId: "gw-1")
    #expect(title == "Allow \"a device\" to access gw-1?")
  }

  @Test("the confirm title uses the exact deviceLabel and gatewayId when present")
  func confirmTitleUsesExactDeviceLabelAndGateway() {
    let title = ApproveDeviceCopy.confirmTitle(deviceLabel: "Chrome on MacBook", gatewayId: "gw-9")
    #expect(title == "Allow \"Chrome on MacBook\" to access gw-9?")
  }
}
