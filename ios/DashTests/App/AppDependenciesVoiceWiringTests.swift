import Foundation
import Testing

@testable import Dash

/// The voice-mode factory is a `ChatFeature` dependency with a `nil`-returning
/// default, so a production wiring that simply never passes it compiles, shows
/// the waveform button (that gate is the gateway's `speech-v1` capability, not
/// the factory) and then does nothing when tapped. Every other voice test
/// injects its own factory, so none of them can see that omission — this suite
/// is the one that builds the chat feature the APP builds.
@MainActor
@Suite("Live dependency wiring — speech")
struct AppDependenciesVoiceWiringTests {
  @Test("the chat feature the app builds can open a voice session")
  func liveChatFeatureBuildsAVoiceSession() async throws {
    let dependencies = try AppDependencies.live()
    let profileID = UUID()
    let keychain = SystemKeychainStore()
    try await keychain.save(
      ConnectionSecrets(
        managementToken: "management-token",
        chatToken: "chat-token",
        relayCredential: nil
      ),
      for: profileID
    )
    defer {
      let store = keychain
      let id = profileID
      Task.detached { try? await store.delete(for: id) }
    }

    let feature = try #require(
      await dependencies.makeChatFeature(
        ConnectionProfileSnapshot(
          gatewayID: "gateway-live-wiring",
          profile: ConnectionProfile(
            id: profileID,
            gatewayId: "gateway-live-wiring",
            publicKey: "public-key",
            label: "Live wiring",
            host: "dash.local",
            managementPort: 9300,
            chatPort: 9200,
            secure: false,
            mode: .lan,
            createdAt: Date(timeIntervalSince1970: 1),
            lastSuccessfulSyncAt: nil
          )
        ),
        ConversationSummaryDTO(
          id: "conversation-live-wiring",
          agentId: "agent-1",
          agentName: "Agent",
          title: "Live wiring",
          revision: 1,
          status: .idle,
          activeTurnId: nil,
          owningIssueId: nil,
          projectId: nil,
          lastSeq: 0,
          lastMessagePreview: nil,
          createdAt: Date(timeIntervalSince1970: 1),
          updatedAt: Date(timeIntervalSince1970: 1),
          deletedAt: nil
        )
      )
    )

    // What the composer does when the gateway advertises `speech-v1`: the
    // waveform button appears, and tapping it asks for a session.
    feature.syncVoiceMode(available: true)
    #expect(feature.voiceModeAvailable)
    #expect(feature.startVoiceMode() != nil)
    await feature.stopVoiceMode()
  }
}
