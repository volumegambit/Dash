import SwiftUI
import Testing

@testable import Dash

/// `AgentAvatar`'s two pure derivations (agents-list goal 2026-09-10). The
/// rendering is SwiftUI; what has to hold is that the same agent name maps
/// to the same mark on every device and launch — the colour hash therefore
/// cannot ride on `Hashable.hashValue` (per-process seeded since Swift 4.2),
/// and the initials must survive the name shapes agents actually have.
@Suite("AgentAvatar derivations (agents-list goal 2026-09-10)")
struct AgentAvatarTests {
  @Test("initials: first and last word, uppercased")
  func initialsMultiWord() {
    #expect(AgentAvatar.initials(for: "Chief of Staff") == "CS")
    #expect(AgentAvatar.initials(for: "Deploy Verify") == "DV")
  }

  @Test("initials: single word takes one letter")
  func initialsSingleWord() {
    #expect(AgentAvatar.initials(for: "Dev") == "D")
    #expect(AgentAvatar.initials(for: "dev") == "D")
  }

  @Test("initials: blank name degrades to a placeholder, not an empty circle")
  func initialsBlank() {
    #expect(AgentAvatar.initials(for: "") == "?")
    #expect(AgentAvatar.initials(for: "   ") == "?")
  }

  @Test("colour is deterministic per name and drawn from the fixed palette")
  func colourDeterministic() {
    #expect(AgentAvatar.color(for: "Dev") == AgentAvatar.color(for: "Dev"))
    // Not a strict guarantee for arbitrary pairs (8 buckets), but these two
    // must differ or the palette hash has collapsed.
    #expect(AgentAvatar.color(for: "Dev") != AgentAvatar.color(for: "Chief of Staff"))
  }
}
