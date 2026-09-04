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
          "pending-recovery",
          "active-recovery",
          "agents",
          "compose-new-chat",
          "settings-forget",
          "signed-out",
          "account-picker",
          "account-picker-error",
          "account-not-enrolled",
          "approve-device",
        ]
      )
    }

    @Test("only startsPaired scenarios launch with a selected profile")
    func profileSelection() async throws {
      for scenario in UITestScenario.allCases where scenario.startsPaired == false {
        let dependencies = try AppDependencies.uiTesting(scenario: scenario)
        #expect(try await dependencies.loadProfile() == nil)
      }

      for scenario in UITestScenario.allCases where scenario.startsPaired {
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

    @Test("active recovery availability is derived again before discard")
    func activeRecoveryRefusesStaleAvailability() async throws {
      let scenario = try #require(UITestScenario(rawValue: "active-recovery"))
      let dependencies = try AppDependencies.uiTesting(scenario: scenario)
      let profile = try #require(try await dependencies.loadProfile())
      let feature = try #require(dependencies.makeConversationListFeature(profile))
      feature.consume(
        SyncSnapshot(
          connection: .online,
          conversations: [
            CachedConversation(
              gatewayID: profile.gatewayID,
              summary: UITestScenarioFixtures.sharedConversation
            )
          ],
          agents: UITestScenarioFixtures.agents,
          lastSuccessfulSyncAt: UITestScenarioFixtures.now
        )
      )
      await feature.start()

      let activeRecovery = try #require(feature.recoverablePendingSends.first)
      #expect(activeRecovery.conversationAvailable)
      #expect(activeRecovery.pendingSend == UITestScenarioFixtures.recoveredPendingSend)
      #expect(activeRecovery.coexistingDraft == UITestScenarioFixtures.recoveredNewerDraft)

      await feature.delete(id: UITestScenarioFixtures.sharedConversation.id, confirmed: true)

      let discardedUsingStaleAvailability = await feature.discardRecovery(activeRecovery)
      #expect(discardedUsingStaleAvailability == false)
      let unavailableRecovery = try #require(feature.recoverablePendingSends.first)
      #expect(unavailableRecovery.conversationAvailable == false)

      let discardedUsingCurrentAvailability = await feature.discardRecovery(unavailableRecovery)
      #expect(discardedUsingCurrentAvailability)
      #expect(feature.recoverablePendingSends.isEmpty)
      await feature.shutdown()
    }

    @Test("active recovery restore preserves the newer draft as a conflict")
    func activeRecoveryRestorePreservesNewerDraft() async throws {
      let store = UITestScenarioStore(
        scenario: .activeRecovery,
        dataIdentifier: "active-restore-conflict"
      )

      let result = await store.restorePendingSendAsDraft(
        gatewayID: "ui-gateway",
        conversationID: UITestScenarioFixtures.sharedConversation.id,
        turnID: UITestScenarioFixtures.recoveredPendingSend.turnID
      )

      #expect(result == .draftConflict(UITestScenarioFixtures.recoveredNewerDraft))
      guard case .recoveryRequired(let recovery) = await store.pendingSend(
        gatewayID: "ui-gateway",
        conversationID: UITestScenarioFixtures.sharedConversation.id
      ) else {
        Issue.record("Expected both recovery copies to remain after the draft conflict")
        return
      }
      #expect(recovery.pendingSend == UITestScenarioFixtures.recoveredPendingSend)
      #expect(recovery.coexistingDraft == UITestScenarioFixtures.recoveredNewerDraft)
      #expect(recovery.conversationAvailable)
    }

    @Test("unavailable conversation clear preserves the pending recovery")
    func unavailableConversationClearPreservesRecovery() async throws {
      let store = UITestScenarioStore(
        scenario: .activeRecovery,
        dataIdentifier: "unavailable-clear"
      )
      _ = try await store.delete(
        id: UITestScenarioFixtures.sharedConversation.id,
        revision: UITestScenarioFixtures.sharedConversation.revision
      )

      let result = await store.clearPendingSend(
        gatewayID: "ui-gateway",
        conversationID: UITestScenarioFixtures.sharedConversation.id,
        turnID: UITestScenarioFixtures.recoveredPendingSend.turnID
      )

      #expect(result == .conversationUnavailable)
      guard case .recoveryRequired(let recovery) = await store.pendingSend(
        gatewayID: "ui-gateway",
        conversationID: UITestScenarioFixtures.sharedConversation.id
      ) else {
        Issue.record("Expected the pending recovery to remain after unavailable clear")
        return
      }
      #expect(recovery.pendingSend == UITestScenarioFixtures.recoveredPendingSend)
      #expect(recovery.coexistingDraft == UITestScenarioFixtures.recoveredNewerDraft)
      #expect(recovery.conversationAvailable == false)
    }

    @Test("unavailable conversation restore preserves both recovery copies")
    func unavailableConversationRestorePreservesRecoveryCopies() async throws {
      let store = UITestScenarioStore(
        scenario: .activeRecovery,
        dataIdentifier: "unavailable-restore"
      )
      _ = try await store.delete(
        id: UITestScenarioFixtures.sharedConversation.id,
        revision: UITestScenarioFixtures.sharedConversation.revision
      )

      let result = await store.restorePendingSendAsDraft(
        gatewayID: "ui-gateway",
        conversationID: UITestScenarioFixtures.sharedConversation.id,
        turnID: UITestScenarioFixtures.recoveredPendingSend.turnID
      )

      #expect(result == .conversationUnavailable)
      guard case .recoveryRequired(let recovery) = await store.pendingSend(
        gatewayID: "ui-gateway",
        conversationID: UITestScenarioFixtures.sharedConversation.id
      ) else {
        Issue.record("Expected both recovery copies to remain after unavailable restore")
        return
      }
      #expect(recovery.pendingSend == UITestScenarioFixtures.recoveredPendingSend)
      #expect(recovery.coexistingDraft == UITestScenarioFixtures.recoveredNewerDraft)
      #expect(recovery.conversationAvailable == false)
    }

    @Test("active recovery discard updates a mounted chat through the shared signal")
    func activeRecoveryDiscardUpdatesMountedChat() async throws {
      let dependencies = try AppDependencies.uiTesting(scenario: .activeRecovery)
      let profile = try #require(try await dependencies.loadProfile())
      let listFeature = try #require(dependencies.makeConversationListFeature(profile))
      let chatFeature = try #require(
        await dependencies.makeChatFeature(
          profile,
          UITestScenarioFixtures.sharedConversation
        )
      )
      listFeature.consume(
        SyncSnapshot(
          connection: .online,
          conversations: [
            CachedConversation(
              gatewayID: profile.gatewayID,
              summary: UITestScenarioFixtures.sharedConversation
            )
          ],
          agents: UITestScenarioFixtures.agents,
          lastSuccessfulSyncAt: UITestScenarioFixtures.now
        )
      )
      chatFeature.setConnection(.online)
      await listFeature.start()
      await chatFeature.appear()

      let recovery = try #require(listFeature.recoverablePendingSends.first)
      #expect(chatFeature.pendingSendRecovery == recovery)
      #expect(chatFeature.state.draft == UITestScenarioFixtures.recoveredNewerDraft.text)
      #expect(chatFeature.state.attachments == UITestScenarioFixtures.recoveredNewerDraft.attachments)
      #expect(chatFeature.draftEditingAllowed == false)
      #expect(chatFeature.canSend == false)

      #expect(await listFeature.discardRecovery(recovery))
      for _ in 0..<100 where chatFeature.pendingSendRecovery != nil {
        await Task.yield()
      }

      #expect(chatFeature.pendingSendRecovery == nil)
      #expect(chatFeature.state.draft == UITestScenarioFixtures.recoveredNewerDraft.text)
      #expect(chatFeature.state.attachments == UITestScenarioFixtures.recoveredNewerDraft.attachments)
      #expect(chatFeature.draftEditingAllowed)
      #expect(chatFeature.canSend)

      let editedDraft = "  Edited after mounted recovery discard  "
      await chatFeature.updateDraft(editedDraft)
      #expect(chatFeature.state.draft == editedDraft)
      #expect(chatFeature.canSend)

      await chatFeature.shutdown()
      await listFeature.shutdown()
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
