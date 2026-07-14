@preconcurrency import AVFoundation
import Foundation
import UIKit

extension AppDependenciesFactory {
  @MainActor
  static var processEnvironment: AppDependenciesFactory {
    #if DEBUG
      let environment = ProcessInfo.processInfo.environment
      let arguments = ProcessInfo.processInfo.arguments
      let rawScenario =
        environment["DASH_UI_TEST_SCENARIO"]
        ?? arguments.uiTestValue(after: "--dash-ui-test-scenario")
      if let rawScenario {
        let rawPasteboardFixture =
          environment["DASH_UI_TEST_PASTEBOARD_FIXTURE"]
          ?? arguments.uiTestValue(after: "--dash-ui-test-pasteboard-fixture")
        let dataIdentifier =
          environment["DASH_UI_TEST_DATA_IDENTIFIER"]
          ?? arguments.uiTestValue(after: "--dash-ui-test-data-identifier")
          ?? UUID().uuidString
        return AppDependenciesFactory {
          guard let scenario = UITestScenario(rawValue: rawScenario) else {
            throw UITestScenarioError.unsupported(rawScenario)
          }
          if let rawPasteboardFixture {
            guard let fixture = UITestPasteboardFixture(rawValue: rawPasteboardFixture) else {
              throw UITestScenarioError.unsupportedPasteboardFixture(rawPasteboardFixture)
            }
            UIPasteboard.general.string = fixture.contents
          }
          return try AppDependencies.uiTesting(
            scenario: scenario,
            dataIdentifier: dataIdentifier
          )
        }
      }
    #endif
    return .live
  }
}

#if DEBUG
  extension Array where Element == String {
    fileprivate func uiTestValue(after option: String) -> String? {
      guard let index = firstIndex(of: option) else { return nil }
      let valueIndex = index + 1
      guard indices.contains(valueIndex) else { return nil }
      return self[valueIndex]
    }
  }

  enum UITestScenarioError: Error, Equatable, Sendable {
    case unsupported(String)
    case unsupportedPasteboardFixture(String)
  }

  enum UITestScenario: String, CaseIterable, Sendable {
    case unpaired
    case pairedOnline = "paired-online"
    case pairedOffline = "paired-offline"
    case streamingReconnect = "streaming-reconnect"
    case remoteBusy = "remote-busy"
    case agents
    case settingsForget = "settings-forget"

    var startsPaired: Bool { self != .unpaired }

    var connection: GatewayConnectionState {
      self == .pairedOffline ? .offline : .online
    }
  }

  enum UITestPasteboardFixture: String, CaseIterable, Sendable {
    case canonicalLAN = "canonical-lan"
    case canonicalRelay = "canonical-relay"
    case malformedScheme = "malformed-scheme"
    case malformedPath = "malformed-path"
    case malformedPort = "malformed-port"

    var contents: String {
      switch self {
      case .canonicalLAN:
        #"{"v":3,"host":"192.168.1.50","mgmtToken":"mobile-test-token","chatToken":"mobile-test-token","mgmtPort":9400,"chatPort":9400,"secure":true,"tlsCertificateSha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}"#
      case .canonicalRelay:
        #"{"v":2,"host":"gateway-01.relay.dash.example","secure":true,"mgmtToken":"mobile-test-token","chatToken":"mobile-test-token","relayCredential":"relay-device-credential"}"#
      case .malformedScheme:
        "dash://pair?payload=not-json"
      case .malformedPath:
        #"{"v":1,"host":"gateway.local/path","mgmtToken":"m","chatToken":"m"}"#
      case .malformedPort:
        #"{"v":1,"host":"gateway.local","mgmtToken":"m","chatToken":"m","mgmtPort":70000}"#
      }
    }
  }

  enum UITestScenarioFixtures {
    static let now = Date(timeIntervalSince1970: 1_750_000_000)

    static let profile = ConnectionProfileSnapshot(
      gatewayID: "ui-gateway",
      profile: ConnectionProfile(
        id: UUID(uuidString: "A0000000-0000-0000-0000-000000000001")!,
        gatewayId: "ui-gateway",
        publicKey: "ui-public-key-for-accessibility",
        label: "UI Test Gateway",
        host: "dash-ui.local",
        managementPort: 9400,
        chatPort: 9400,
        secure: true,
        mode: .lan,
        tlsCertificateSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        createdAt: now,
        lastSuccessfulSyncAt: now
      )
    )

    static let sharedConversation = ConversationSummaryDTO(
      id: "shared-plan",
      agentId: "research-agent",
      agentName: "Research Agent",
      title: "Shared launch plan",
      revision: 1,
      status: .idle,
      activeTurnId: nil,
      owningIssueId: nil,
      projectId: nil,
      lastSeq: 0,
      lastMessagePreview: "Saved from your Mac",
      createdAt: now.addingTimeInterval(-600),
      updatedAt: now,
      deletedAt: nil
    )

    static let agents: [RegisteredAgentDTO] = [
      agent(
        id: "research-agent",
        name: "Research Agent",
        model: "openai/gpt-5",
        prompt: "Research carefully",
        status: .registered
      ),
      agent(
        id: "sleeping-agent",
        name: "Sleeping Agent",
        model: "anthropic/claude-sonnet-4-5",
        prompt: "Wait for instructions",
        status: .disabled
      ),
      agent(
        id: "delete-agent",
        name: "Delete Me",
        model: "openai/gpt-5-mini",
        prompt: "Temporary agent",
        status: .registered
      ),
    ]

    static let models: [ModelDTO] = [
      ModelDTO(value: "openai/gpt-5", label: "GPT-5", provider: "OpenAI"),
      ModelDTO(value: "openai/gpt-5-mini", label: "GPT-5 mini", provider: "OpenAI"),
      ModelDTO(
        value: "anthropic/claude-sonnet-4-5",
        label: "Claude Sonnet 4.5",
        provider: "Anthropic"
      ),
    ]

    static func conversation(for scenario: UITestScenario) -> ConversationSummaryDTO {
      guard scenario == .remoteBusy else { return sharedConversation }
      return copy(
        sharedConversation,
        revision: 2,
        status: .running,
        activeTurnID: "remote-ui-turn",
        lastSequence: 2
      )
    }

    static func cachedMessages(for scenario: UITestScenario) -> [ConversationMessageDTO] {
      if scenario == .streamingReconnect { return [] }
      if scenario == .remoteBusy {
        return [
          message(
            id: "remote-assistant",
            turnID: "remote-ui-turn",
            role: .assistant,
            status: .streaming,
            events: [.textDelta(text: "Working on another device")],
            ordinal: 1
          )
        ]
      }
      return [
        message(
          id: "cached-user",
          turnID: "cached-turn",
          role: .user,
          status: .completed,
          text: "Saved from your Mac",
          ordinal: 1
        ),
        message(
          id: "cached-assistant",
          turnID: "cached-turn",
          role: .assistant,
          status: .completed,
          events: [
            .response(
              content: "This reply is available offline.",
              usage: UsageDTO(
                inputTokens: 4,
                outputTokens: 6,
                cacheReadTokens: nil,
                cacheWriteTokens: nil
              )
            )
          ],
          ordinal: 2
        ),
      ]
    }

    static func agent(
      id: String,
      name: String,
      model: String,
      prompt: String,
      status: RegisteredAgentStatus
    ) -> RegisteredAgentDTO {
      RegisteredAgentDTO(
        id: id,
        name: name,
        config: AgentConfigDTO(
          name: name,
          model: model,
          systemPrompt: prompt,
          fallbackModels: nil,
          tools: ["read", "search"],
          skills: nil,
          workspace: nil,
          maxTokens: nil,
          mcpServers: nil,
          swarm: nil,
          plugins: nil,
          providers: nil
        ),
        status: status,
        registeredAt: now
      )
    }

    static func message(
      id: String,
      turnID: String,
      role: MessageRole,
      status: MessageStatus,
      text: String = "",
      events: [AgentEvent] = [],
      ordinal: Int
    ) -> ConversationMessageDTO {
      ConversationMessageDTO(
        id: id,
        conversationId: sharedConversation.id,
        turnId: turnID,
        ordinal: ordinal,
        role: role,
        status: status,
        content: role == .user ? .user(text: text, images: nil) : .assistant(events: events),
        createdAt: now.addingTimeInterval(TimeInterval(ordinal)),
        updatedAt: now.addingTimeInterval(TimeInterval(ordinal))
      )
    }

    static func copy(
      _ value: ConversationSummaryDTO,
      title: String? = nil,
      revision: Int? = nil,
      status: ConversationStatus? = nil,
      activeTurnID: String? = nil,
      lastSequence: Int? = nil,
      deletedAt: Date? = nil
    ) -> ConversationSummaryDTO {
      ConversationSummaryDTO(
        id: value.id,
        agentId: value.agentId,
        agentName: value.agentName,
        title: title ?? value.title,
        revision: revision ?? value.revision,
        status: status ?? value.status,
        activeTurnId: activeTurnID,
        owningIssueId: value.owningIssueId,
        projectId: value.projectId,
        lastSeq: lastSequence ?? value.lastSeq,
        lastMessagePreview: value.lastMessagePreview,
        createdAt: value.createdAt,
        updatedAt: now,
        deletedAt: deletedAt
      )
    }
  }

  extension AppDependencies {
    @MainActor
    static func uiTesting(
      scenario: UITestScenario,
      dataIdentifier: String = UUID().uuidString
    ) throws -> AppDependencies {
      let store = UITestScenarioStore(scenario: scenario, dataIdentifier: dataIdentifier)
      let keychain = UITestKeychainStore()
      let clock = UITestClock()

      return AppDependencies(
        clock: clock,
        loadProfile: {
          scenario.startsPaired ? UITestScenarioFixtures.profile : nil
        },
        makeSyncEngine: { _ in
          UITestSyncEngine(snapshot: await store.syncSnapshot())
        },
        verifyProfile: { _ in },
        rememberProfile: { _ in },
        deleteProfileSecrets: { profile in
          await keychain.delete(for: profile.id)
        },
        clearProfileData: { _ in
          await store.clear()
        },
        forgetProfileSelection: { _ in },
        makeConversationListFeature: { profile in
          ConversationListFeature(gatewayID: profile.gatewayID, service: store)
        },
        makeAgentsFeature: { profile in
          AgentsFeature(gatewayID: profile.gatewayID, service: store)
        },
        makeChatFeature: { profile, conversation in
          let source = UITestIdentifierSource(values: ["ui-turn", "ui-local-user"])
          return ChatFeature(
            gatewayID: profile.gatewayID,
            conversation: conversation,
            persistence: store,
            synchronizer: store,
            transport: UITestChatTransport(),
            clock: clock,
            announcer: UITestAccessibilityAnnouncer(),
            makeID: { source.next() }
          )
        },
        pairingFeatureFactory: PairingFeatureFactory(
          verifier: UITestPairingVerifier(),
          installer: UITestPairingInstaller(keychain: keychain),
          makeScanner: {
            if scenario == .unpaired {
              return QRScannerService()
            }
            return UITestCameraScanner()
          }
        )
      )
    }
  }

  private struct UITestClock: AppClock {
    func now() async -> Date { UITestScenarioFixtures.now }

    func sleep(for duration: Duration) async throws {
      try await ContinuousClock().sleep(for: duration)
    }
  }

  private actor UITestKeychainStore: KeychainStoring {
    private var values: [UUID: ConnectionSecrets] = [:]

    func save(_ secrets: ConnectionSecrets, for profileID: UUID) {
      values[profileID] = secrets
    }

    func load(for profileID: UUID) -> ConnectionSecrets? {
      values[profileID]
    }

    func delete(for profileID: UUID) {
      values[profileID] = nil
    }
  }

  private struct UITestPairingVerifier: PairingVerifying {
    func verify(
      payload: PairingPayload,
      onStep: @escaping @MainActor @Sendable (PairingVerificationStep) -> Void
    ) async throws -> VerifiedPairing {
      let (proposed, secrets) = try payload.validated(
        profileID: UUID(uuidString: "A0000000-0000-0000-0000-000000000002")!
      )
      for step in [
        PairingVerificationStep.reachability,
        .capabilities,
        .identity,
        .agents,
        .chat,
      ] {
        await onStep(step)
        await Task.yield()
      }
      var profile = proposed
      profile.gatewayId = "ui-gateway"
      profile.publicKey = "ui-public-key-for-accessibility"
      return VerifiedPairing(
        profile: ConnectionProfileSnapshot(gatewayID: "ui-gateway", profile: profile),
        identity: GatewayIdentityDTO(
          gatewayId: "ui-gateway",
          publicKey: "ui-public-key-for-accessibility"
        ),
        secrets: secrets
      )
    }
  }

  private actor UITestPairingInstaller: PairingProfileInstalling {
    private let keychain: any KeychainStoring

    init(keychain: any KeychainStoring) {
      self.keychain = keychain
    }

    func install(_ pairing: VerifiedPairing) async throws -> ConnectionProfileSnapshot {
      try await keychain.save(pairing.secrets, for: pairing.profile.id)
      return pairing.profile
    }
  }

  private actor UITestCameraScanner: QRScanning {
    private var status: AVAuthorizationStatus = .notDetermined

    func authorizationStatus() -> AVAuthorizationStatus {
      status
    }

    func requestAccess() async -> Bool {
      status = .denied
      return false
    }

    func scan() async throws -> String {
      throw QRScannerError.cameraUnavailable
    }

    func stop() {}
  }

  private actor UITestSyncEngine: AppSyncing {
    private let snapshot: SyncSnapshot
    private let stream: AsyncStream<SyncSnapshot>
    private let continuation: AsyncStream<SyncSnapshot>.Continuation

    init(snapshot: SyncSnapshot) {
      self.snapshot = snapshot
      let pair = AsyncStream<SyncSnapshot>.makeStream(bufferingPolicy: .bufferingNewest(1))
      stream = pair.stream
      continuation = pair.continuation
    }

    func snapshots() -> AsyncStream<SyncSnapshot> { stream }

    func bootstrap() {
      continuation.yield(snapshot)
    }

    func sceneDidEnterBackground() {}

    func sceneWillEnterForeground() {
      continuation.yield(snapshot)
    }

    func shutdown() {
      continuation.finish()
    }
  }

  private actor UITestScenarioStore: ConversationListServicing, AgentsServicing,
    ChatFeaturePersisting, ChatFeatureSynchronizing
  {
    private let dataIdentifier: String
    private let scenario: UITestScenario
    private var conversationValues: [ConversationSummaryDTO]
    private var agentValues: [RegisteredAgentDTO]
    private var messages: [String: [ConversationMessageDTO]]
    private var drafts: [String: ConversationDraft] = [:]
    private var pendingSends: [String: PendingChatSend] = [:]
    private var cursors: [String: Int] = [:]
    private var retainedRequests: [String: String] = [:]
    private var didFailSleepingAgentEnable = false

    init(scenario: UITestScenario, dataIdentifier: String) {
      self.dataIdentifier = dataIdentifier
      self.scenario = scenario
      let conversation = UITestScenarioFixtures.conversation(for: scenario)
      conversationValues = [conversation]
      agentValues = UITestScenarioFixtures.agents
      messages = [conversation.id: UITestScenarioFixtures.cachedMessages(for: scenario)]
      cursors[conversation.id] = conversation.lastSeq
    }

    func syncSnapshot() -> SyncSnapshot {
      SyncSnapshot(
        connection: scenario.connection,
        conversations:
          conversationValues
          .filter { $0.status != .deleted }
          .map { CachedConversation(gatewayID: "ui-gateway", summary: $0) },
        agents: agentValues,
        lastSuccessfulSyncAt: UITestScenarioFixtures.now,
        removedConversationIDs: Set(conversationValues.filter { $0.status == .deleted }.map(\.id))
      )
    }

    func clear() {
      conversationValues.removeAll()
      agentValues.removeAll()
      messages.removeAll()
      drafts.removeAll()
      pendingSends.removeAll()
      cursors.removeAll()
      retainedRequests.removeAll()
      _ = dataIdentifier
    }

    func cachedConversations() -> [CachedConversation] {
      conversationValues
        .filter { $0.status != .deleted }
        .map { CachedConversation(gatewayID: "ui-gateway", summary: $0) }
    }

    func cachedAgents() -> [RegisteredAgentDTO] { agentValues }

    func refreshAgents() -> [RegisteredAgentDTO] { agentValues }

    func conversations(
      agentID: String?,
      limit: Int,
      cursor: String?
    ) -> ConversationPageDTO {
      _ = limit
      _ = cursor
      return ConversationPageDTO(
        items: conversationValues.filter {
          $0.status != .deleted && (agentID == nil || $0.agentId == agentID)
        },
        nextCursor: nil
      )
    }

    func create(_ request: CreateConversationRequest) -> ConversationSummaryDTO {
      if let existing = conversationValues.first(where: { $0.agentId == request.agentId }) {
        return existing
      }
      let agent = agentValues.first { $0.id == request.agentId }
      let value = ConversationSummaryDTO(
        id: "conversation-\(request.agentId)",
        agentId: request.agentId,
        agentName: agent?.name ?? "Agent",
        title: "Chat with \(agent?.name ?? "Agent")",
        revision: 1,
        status: .idle,
        activeTurnId: nil,
        owningIssueId: nil,
        projectId: nil,
        lastSeq: 0,
        lastMessagePreview: nil,
        createdAt: UITestScenarioFixtures.now,
        updatedAt: UITestScenarioFixtures.now,
        deletedAt: nil
      )
      conversationValues.append(value)
      messages[value.id] = []
      return value
    }

    func reconcileCreate(_ request: CreateConversationRequest) -> ConversationSummaryDTO {
      create(request)
    }

    func rename(id: String, title: String, revision: Int) throws -> ConversationSummaryDTO {
      guard let index = conversationValues.firstIndex(where: { $0.id == id }) else {
        throw GatewayError.notFound
      }
      let current = conversationValues[index]
      guard current.revision == revision else {
        throw GatewayError.revisionConflict(current: current)
      }
      let renamed = UITestScenarioFixtures.copy(
        current,
        title: title,
        revision: revision + 1,
        activeTurnID: current.activeTurnId
      )
      conversationValues[index] = renamed
      return renamed
    }

    func delete(id: String, revision: Int) throws -> ConversationSummaryDTO {
      guard let index = conversationValues.firstIndex(where: { $0.id == id }) else {
        throw GatewayError.notFound
      }
      let current = conversationValues[index]
      guard current.revision == revision else {
        throw GatewayError.revisionConflict(current: current)
      }
      let deleted = UITestScenarioFixtures.copy(
        current,
        revision: revision + 1,
        status: .deleted,
        lastSequence: current.lastSeq,
        deletedAt: UITestScenarioFixtures.now
      )
      conversationValues[index] = deleted
      return deleted
    }

    func replace(_ summary: ConversationSummaryDTO) {
      if let index = conversationValues.firstIndex(where: { $0.id == summary.id }) {
        conversationValues[index] = summary
      } else {
        conversationValues.append(summary)
      }
    }

    func remove(id: String) {
      conversationValues.removeAll { $0.id == id }
      messages[id] = nil
    }

    func retainedCreateRequestID(agentID: String, suggested: String) -> String {
      if let retained = retainedRequests[agentID] { return retained }
      retainedRequests[agentID] = suggested
      return suggested
    }

    func clearRetainedCreateRequestID(agentID: String) {
      retainedRequests[agentID] = nil
    }

    func models() -> [ModelDTO] { UITestScenarioFixtures.models }

    func create(_ request: CreateAgentRequest) -> RegisteredAgentDTO {
      let base = request.name
        .lowercased()
        .split(whereSeparator: { $0.isLetter == false && $0.isNumber == false })
        .joined(separator: "-")
      var id = base.isEmpty ? "created-agent" : base
      var suffix = 2
      while agentValues.contains(where: { $0.id == id }) {
        id = "\(base)-\(suffix)"
        suffix += 1
      }
      let value = UITestScenarioFixtures.agent(
        id: id,
        name: request.name,
        model: request.model,
        prompt: request.systemPrompt,
        status: .registered
      )
      agentValues.append(value)
      return value
    }

    func update(id: String, request: UpdateAgentRequest) throws -> RegisteredAgentDTO {
      guard let index = agentValues.firstIndex(where: { $0.id == id }) else {
        throw GatewayError.notFound
      }
      let current = agentValues[index]
      let config = AgentConfigDTO(
        name: current.config.name,
        model: request.model ?? current.config.model,
        systemPrompt: request.systemPrompt ?? current.config.systemPrompt,
        fallbackModels: current.config.fallbackModels,
        tools: current.config.tools,
        skills: current.config.skills,
        workspace: current.config.workspace,
        maxTokens: current.config.maxTokens,
        mcpServers: current.config.mcpServers,
        swarm: current.config.swarm,
        plugins: current.config.plugins,
        providers: current.config.providers
      )
      let value = RegisteredAgentDTO(
        id: current.id,
        name: current.name,
        config: config,
        status: current.status,
        registeredAt: current.registeredAt
      )
      agentValues[index] = value
      return value
    }

    func setEnabled(id: String, enabled: Bool) async throws -> RegisteredAgentDTO {
      guard let index = agentValues.firstIndex(where: { $0.id == id }) else {
        throw GatewayError.notFound
      }
      if id == "sleeping-agent", enabled, didFailSleepingAgentEnable == false {
        didFailSleepingAgentEnable = true
        try await Task.sleep(for: .seconds(1))
        throw GatewayError.validation("Scripted enable failure")
      }
      let current = agentValues[index]
      let value = RegisteredAgentDTO(
        id: current.id,
        name: current.name,
        config: current.config,
        status: enabled ? .registered : .disabled,
        registeredAt: current.registeredAt
      )
      agentValues[index] = value
      return value
    }

    func delete(id: String) throws {
      guard agentValues.contains(where: { $0.id == id }) else {
        throw GatewayError.notFound
      }
      agentValues.removeAll { $0.id == id }
    }

    func startConversation(agentID: String) throws -> ConversationSummaryDTO {
      if let existing = conversationValues.first(where: { $0.agentId == agentID }) {
        return existing
      }
      return create(
        CreateConversationRequest(
          agentId: agentID,
          requestId: "ui-start-chat",
          title: nil,
          owningIssueId: nil,
          projectId: nil
        )
      )
    }

    func messages(
      gatewayID: String,
      conversationID: String
    ) -> [ConversationMessageDTO] {
      _ = gatewayID
      return messages[conversationID] ?? []
    }

    func draft(gatewayID: String, conversationID: String) -> ConversationDraft? {
      _ = gatewayID
      return drafts[conversationID]
    }

    func pendingSend(gatewayID: String, conversationID: String) -> PendingChatSend? {
      _ = gatewayID
      return pendingSends[conversationID]
    }

    func cursor(gatewayID: String, conversationID: String) -> Int {
      _ = gatewayID
      return cursors[conversationID] ?? 0
    }

    func saveDraft(
      _ draft: ConversationDraft,
      gatewayID: String,
      conversationID: String
    ) {
      _ = gatewayID
      drafts[conversationID] = draft
    }

    func stagePendingSend(
      _ pending: PendingChatSend,
      gatewayID: String,
      conversationID: String
    ) {
      _ = gatewayID
      pendingSends[conversationID] = pending
      drafts[conversationID] = nil
    }

    func clearPendingSend(gatewayID: String, conversationID: String, turnID: String) {
      _ = gatewayID
      guard pendingSends[conversationID]?.turnID == turnID else { return }
      pendingSends[conversationID] = nil
    }

    func restorePendingSendAsDraft(
      gatewayID: String,
      conversationID: String,
      turnID: String
    ) -> ConversationDraft? {
      _ = gatewayID
      guard let pending = pendingSends[conversationID], pending.turnID == turnID else {
        return nil
      }
      let draft = ConversationDraft(
        text: pending.draft,
        attachments: pending.attachments,
        updatedAt: pending.createdAt
      )
      pendingSends[conversationID] = nil
      drafts[conversationID] = draft
      return draft
    }

    func advanceCursor(gatewayID: String, conversationID: String, to seq: Int) {
      _ = gatewayID
      cursors[conversationID] = max(cursors[conversationID] ?? 0, seq)
    }

    func refresh(conversationID: String, before: String?) throws -> ChatCanonicalSnapshot {
      _ = before
      guard let summary = conversationValues.first(where: { $0.id == conversationID }) else {
        throw GatewayError.notFound
      }
      return ChatCanonicalSnapshot(
        summary: summary,
        messages: messages[conversationID] ?? [],
        nextCursor: nil,
        throughSeq: summary.lastSeq
      )
    }

    func replay(
      agentID: String,
      conversationID: String,
      sinceSeq: Int
    ) -> [ReplayEntryDTO] {
      _ = agentID
      _ = conversationID
      _ = sinceSeq
      return []
    }

    func shutdown() {}
  }

  private final class UITestIdentifierSource: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String]

    init(values: [String]) {
      self.values = values
    }

    func next() -> String {
      lock.withLock {
        if values.isEmpty { return UUID().uuidString.lowercased() }
        return values.removeFirst()
      }
    }
  }

  private actor UITestAccessibilityAnnouncer: ChatAccessibilityAnnouncing {
    func isVoiceOverRunning() -> Bool { false }
    func announce(_ value: String) { _ = value }
  }

  private actor UITestChatTransport: ChatFeatureTransporting {
    private var stream: AsyncThrowingStream<ChatConnectionEvent, Error>
    private var continuation: AsyncThrowingStream<ChatConnectionEvent, Error>.Continuation
    private var scriptTask: Task<Void, Never>?
    private var activeTurnID: String?
    private var nextSequence = 1
    private var isTerminal = false

    init() {
      let pair = AsyncThrowingStream<ChatConnectionEvent, Error>.makeStream()
      stream = pair.stream
      continuation = pair.continuation
    }

    func events() -> AsyncThrowingStream<ChatConnectionEvent, Error> { stream }

    func resetAfterTerminalFailure() {
      let pair = AsyncThrowingStream<ChatConnectionEvent, Error>.makeStream()
      stream = pair.stream
      continuation = pair.continuation
    }

    func connect() {}

    func sendTurn(
      id: String,
      agentID: String,
      conversationID: String,
      text: String,
      images: [MessageImage]
    ) {
      _ = agentID
      _ = text
      _ = images
      activeTurnID = id
      nextSequence = 1
      isTerminal = false
      scriptTask?.cancel()
      scriptTask = Task { [weak self] in
        await self?.runScript(turnID: id, conversationID: conversationID)
      }
    }

    func resume(
      turnID: String,
      agentID: String,
      conversationID: String,
      sinceSeq: Int
    ) {
      _ = turnID
      _ = agentID
      _ = conversationID
      _ = sinceSeq
    }

    func answer(turnID: String, questionID: String, answer: String) {
      _ = turnID
      _ = questionID
      _ = answer
    }

    func cancel(turnID: String) {
      guard activeTurnID == turnID, isTerminal == false else { return }
      scriptTask?.cancel()
      yield(
        .done(
          id: turnID,
          conversationId: UITestScenarioFixtures.sharedConversation.id,
          seq: nextSequence,
          outcome: .cancelled
        )
      )
      isTerminal = true
      activeTurnID = nil
    }

    func suspendForDetachment() {
      continuation.yield(.state(.detached))
    }

    func shutdown() {
      scriptTask?.cancel()
      continuation.finish()
    }

    private func runScript(turnID: String, conversationID: String) async {
      guard await pause(.milliseconds(150)) else { return }
      yield(
        .accepted(
          id: turnID,
          conversationId: conversationID,
          userMessageId: "user-ui-turn",
          assistantMessageId: "assistant-ui-turn",
          revision: 2,
          seq: takeSequence()
        )
      )
      guard await pause(.milliseconds(100)) else { return }
      yieldEvent(
        turnID: turnID,
        conversationID: conversationID,
        .thinkingDelta(text: "Checking the shared context")
      )
      yieldEvent(
        turnID: turnID,
        conversationID: conversationID,
        .textDelta(text: "Recovered exactly ")
      )
      yieldEvent(
        turnID: turnID,
        conversationID: conversationID,
        .toolUseStart(
          id: "ui-tool",
          name: "search",
          input: .object(["query": .string("launch plan")])
        )
      )
      yieldEvent(
        turnID: turnID,
        conversationID: conversationID,
        .toolResult(
          id: "ui-tool",
          name: "search",
          content: "Found the rollout checklist",
          isError: false,
          details: nil
        )
      )
      yieldEvent(
        turnID: turnID,
        conversationID: conversationID,
        .workerSpawned(
          workerId: "ui-worker",
          runId: "ui-run",
          role: "researcher",
          brief: "Check launch readiness",
          model: "openai/gpt-5"
        )
      )
      yieldEvent(
        turnID: turnID,
        conversationID: conversationID,
        .workerStatus(
          workerId: "ui-worker",
          runId: "ui-run",
          role: "researcher",
          status: .running,
          detail: "Reviewing the checklist",
          question: nil
        )
      )
      yieldEvent(
        turnID: turnID,
        conversationID: conversationID,
        .question(id: "ui-question", question: "Ship this plan?", options: ["Ship it", "Wait"])
      )
      continuation.yield(.state(.reconnecting(attempt: 1)))
      guard await pause(.seconds(4)) else { return }
      continuation.yield(.state(.connected))
      yieldEvent(
        turnID: turnID,
        conversationID: conversationID,
        .textDelta(text: "once.")
      )
      yieldEvent(
        turnID: turnID,
        conversationID: conversationID,
        .response(
          content: "Recovered exactly once.",
          usage: UsageDTO(
            inputTokens: 12,
            outputTokens: 18,
            cacheReadTokens: 4,
            cacheWriteTokens: nil
          )
        )
      )
      yield(
        .done(
          id: turnID,
          conversationId: conversationID,
          seq: takeSequence(),
          outcome: .completed
        )
      )
      isTerminal = true
      activeTurnID = nil
    }

    private func yieldEvent(
      turnID: String,
      conversationID: String,
      _ event: AgentEvent
    ) {
      yield(
        .event(
          id: turnID,
          conversationId: conversationID,
          seq: takeSequence(),
          event: event
        )
      )
    }

    private func yield(_ frame: MobileWSServerFrame) {
      guard isTerminal == false else { return }
      continuation.yield(.frame(frame))
    }

    private func takeSequence() -> Int {
      defer { nextSequence += 1 }
      return nextSequence
    }

    private func pause(_ duration: Duration) async -> Bool {
      do {
        try await ContinuousClock().sleep(for: duration)
        return Task.isCancelled == false
      } catch {
        return false
      }
    }
  }
#endif
