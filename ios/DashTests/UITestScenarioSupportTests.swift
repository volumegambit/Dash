import Testing

@testable import Dash

#if DEBUG
  @Suite("UI test scenario support")
  @MainActor
  struct UITestScenarioSupportTests {
    @Test("the supported scenario names are stable")
    func stableNames() {
      #expect(
        UITestScenario.allCases.map(\.rawValue) == [
          "unpaired",
          "paired-online",
          "paired-offline",
          "streaming-reconnect",
          "remote-busy",
          "agents",
          "settings-forget",
        ]
      )
    }

    @Test("pasteboard fixture identifiers are stable and resolve inside the debug binary")
    func pasteboardFixtures() {
      #expect(
        UITestPasteboardFixture.allCases.map(\.rawValue) == [
          "canonical-lan",
          "canonical-relay",
          "malformed-scheme",
          "malformed-path",
          "malformed-port",
        ]
      )
      #expect(UITestPasteboardFixture.canonicalLAN.contents.contains("mgmt-test-token"))
      #expect(UITestPasteboardFixture.canonicalRelay.contents.contains("relay-device-credential"))
      #expect(UITestPasteboardFixture.malformedScheme.contents == "dash://pair?payload=not-json")
    }

    @Test("unpaired is the only scenario without a selected profile")
    func profileSelection() async throws {
      let unpaired = try AppDependencies.uiTesting(scenario: .unpaired)
      #expect(try await unpaired.loadProfile() == nil)

      for scenario in UITestScenario.allCases where scenario != .unpaired {
        let dependencies = try AppDependencies.uiTesting(scenario: scenario)
        #expect(try await dependencies.loadProfile()?.gatewayID == "ui-gateway")
      }
    }

    @Test("paired scenario composes real feature models")
    func realFeatures() async throws {
      let dependencies = try AppDependencies.uiTesting(scenario: .pairedOnline)
      let profile = try #require(try await dependencies.loadProfile())

      #expect(dependencies.makeConversationListFeature(profile) != nil)
      #expect(dependencies.makeAgentsFeature(profile) != nil)
      let conversation = UITestScenarioFixtures.sharedConversation
      #expect(await dependencies.makeChatFeature(profile, conversation) != nil)
    }

    @Test("paired scenario starts the app on the paired root")
    func startsPaired() async throws {
      let dependencies = try AppDependencies.uiTesting(scenario: .pairedOnline)
      let model = AppModel(dependencies: dependencies)

      await model.start()

      #expect(model.selectedProfile?.gatewayID == "ui-gateway")
      #expect(model.conversationListFeature != nil)
      #expect(model.agentsFeature != nil)
    }

    @Test("agent enable failure rolls back without losing online authority")
    func agentEnableFailure() async throws {
      let dependencies = try AppDependencies.uiTesting(scenario: .agents)
      let model = AppModel(dependencies: dependencies)
      await model.start()
      let feature = try #require(model.agentsFeature)
      for _ in 0..<100 where feature.mutationsAllowed == false {
        await Task.yield()
      }

      await feature.setEnabled(id: "sleeping-agent", enabled: true, confirmed: true)

      #expect(feature.agents.first(where: { $0.id == "sleeping-agent" })?.status == .disabled)
      #expect(feature.mutationError == "Dash couldn't complete the agent update.")
      #expect(feature.mutationsAllowed)
    }
  }
#endif
