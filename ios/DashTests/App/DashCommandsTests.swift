import SwiftUI
import Testing

@testable import Dash

@Suite("Keyboard commands (iPad goal Phase B, design §2.1)")
struct DashCommandsTests {
  @Test("every command has a unique shortcut")
  func shortcutsAreUnique() {
    let keys = KeyboardCommand.allCases.map { "\($0.shortcut.key.character)-\($0.shortcut.modifiers.rawValue)" }
    #expect(Set(keys).count == keys.count)
  }

  @Test("shortcut snapshot matches the design table")
  func shortcutSnapshot() {
    #expect(KeyboardCommand.newConversation.shortcut.key == "n")
    #expect(KeyboardCommand.newConversation.shortcut.modifiers == .command)
    #expect(KeyboardCommand.focusSearch.shortcut.key == "f")
    #expect(KeyboardCommand.previousConversation.shortcut.key == "[")
    #expect(KeyboardCommand.previousConversation.shortcut.modifiers == [.command, .shift])
    #expect(KeyboardCommand.nextConversation.shortcut.key == "]")
    #expect(KeyboardCommand.settings.shortcut.key == ",")
    #expect(KeyboardCommand.showConversations.shortcut.key == "1")
    #expect(KeyboardCommand.showAgents.shortcut.key == "2")
    #expect(KeyboardCommand.closeConversation.shortcut.key == "w")
    #expect(KeyboardCommand.send.shortcut.key == .return)
    #expect(KeyboardCommand.stop.shortcut.key == .escape)
    #expect(KeyboardCommand.stop.shortcut.modifiers == [])
    #expect(KeyboardCommand.focusComposer.shortcut.key == "l")
    #expect(KeyboardCommand.copyLastResponse.shortcut.key == "c")
    #expect(KeyboardCommand.copyLastResponse.shortcut.modifiers == [.command, .shift])
  }
}
