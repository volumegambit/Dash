import SwiftUI
import Testing

@testable import Dash

/// Unit coverage for the pure phase-to-intent table `SceneLifecycleModifier`
/// delegates to. This exists because the modifier itself is exercised only
/// by full-app runs — extracting the decision into `SceneLifecycleDecision`
/// makes the `.onChange(initial: true)` arms and the `.onDisappear` release
/// testable without SwiftUI scene machinery. See task-9-review-findings.md.
@Suite("Scene lifecycle decision")
struct SceneLifecycleDecisionTests {
  @Test("active phase seeds the slot")
  func activeSeeds() {
    #expect(SceneLifecycleDecision.isActive(for: .active) == true)
  }

  @Test("background phase releases the slot")
  func backgroundReleases() {
    #expect(SceneLifecycleDecision.isActive(for: .background) == false)
  }

  @Test("inactive phase is a no-op")
  func inactiveIsNoOp() {
    #expect(SceneLifecycleDecision.isActive(for: .inactive) == nil)
  }

  @Test("initial attach while already active registers the scene")
  func initialAttachAtActiveRegisters() {
    // `.onChange(of:initial:)` replays whatever phase is already current at
    // mount time through this same table — a cold launch that reaches
    // `.active` before the modifier attaches must still register the scene,
    // not silently drop it. The decision is phase-only and cannot itself
    // distinguish "initial replay" from "later change"; that invariance is
    // exactly what makes the initial-attach case safe.
    #expect(SceneLifecycleDecision.isActive(for: .active) == true)
  }

  @Test("initial attach while already backgrounded releases a non-member harmlessly")
  func initialAttachAtBackgroundReleases() {
    // Attaching straight into `.background` (e.g. a scene created while the
    // app is backgrounded) must still route to a release — `AppModel`'s
    // `Set.remove` on a non-member is a documented no-op, so this is safe
    // even though the scene was never registered.
    #expect(SceneLifecycleDecision.isActive(for: .background) == false)
  }

  @Test("a disappearing scene always releases its slot")
  func disappearReleases() {
    #expect(SceneLifecycleDecision.onDisappear == false)
  }
}
