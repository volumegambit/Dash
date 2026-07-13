import Foundation

@testable import Dash

enum LiveGatewayEnvironmentError: Error, Equatable, Sendable {
  case missing(String)
  case blank(String)
  case invalidURL(String)
  case unsupportedScenario
  case incompatibleEndpoints
}

struct LiveGatewayEnvironment: Sendable {
  let managementURL: URL
  let chatURL: URL
  let managementToken: String
  let chatToken: String
  let gatewayID: String
  let agentID: String
  let scenario: String

  static func environment(_ values: [String: String]) throws -> Self {
    let managementURLValue = try required("DASH_TEST_MANAGEMENT_URL", in: values)
    let chatURLValue = try required("DASH_TEST_CHAT_URL", in: values)
    let managementToken = try required("DASH_TEST_MANAGEMENT_TOKEN", in: values)
    let chatToken = try required("DASH_TEST_CHAT_TOKEN", in: values)
    let gatewayID = try required("DASH_TEST_GATEWAY_ID", in: values)
    let agentID = try required("DASH_TEST_AGENT_ID", in: values)
    let scenario = try required("DASH_TEST_SCENARIO", in: values)
    guard ["stream", "question", "slow"].contains(scenario) else {
      throw LiveGatewayEnvironmentError.unsupportedScenario
    }

    return LiveGatewayEnvironment(
      managementURL: try absoluteURL(managementURLValue, name: "DASH_TEST_MANAGEMENT_URL"),
      chatURL: try absoluteURL(chatURLValue, name: "DASH_TEST_CHAT_URL"),
      managementToken: managementToken,
      chatToken: chatToken,
      gatewayID: gatewayID,
      agentID: agentID,
      scenario: scenario
    )
  }

  static func processInfo(_ processInfo: ProcessInfo = .processInfo) throws -> Self {
    try environment(processInfo.environment)
  }

  func makeClient() throws -> LiveGatewayClient {
    try makeClient(store: nil)
  }

  fileprivate func makeClient(store: PersistenceStore?) throws -> LiveGatewayClient {
    let endpoint = try connectionEndpoint()
    let secrets = ConnectionSecrets(
      managementToken: managementToken,
      chatToken: chatToken,
      relayCredential: nil
    )
    let transport = HTTPTransport(endpoint: endpoint, secrets: secrets)
    let api = GatewayAPI(transport: transport)
    let sse = SSEClient(endpoint: endpoint, secrets: secrets)
    let chat = ChatConnection(endpoint: endpoint)
    let persistence = try store ?? PersistenceStore.inMemory()
    let sync = ConversationSyncEngine(
      gatewayID: gatewayID,
      store: persistence,
      api: api,
      invalidations: SSEInvalidationSource(client: sse),
      chat: chat,
      reachability: NetworkReachability()
    )
    return LiveGatewayClient(
      environment: self,
      endpoint: endpoint,
      secrets: secrets,
      transport: transport,
      api: api,
      sse: sse,
      chat: chat,
      store: persistence,
      sync: sync
    )
  }

  func replacing(
    managementToken: String? = nil,
    chatToken: String? = nil
  ) -> LiveGatewayEnvironment {
    LiveGatewayEnvironment(
      managementURL: managementURL,
      chatURL: chatURL,
      managementToken: managementToken ?? self.managementToken,
      chatToken: chatToken ?? self.chatToken,
      gatewayID: gatewayID,
      agentID: agentID,
      scenario: scenario
    )
  }

  private func connectionEndpoint() throws -> ConnectionEndpoint {
    guard
      let management = URLComponents(url: managementURL, resolvingAgainstBaseURL: false),
      let chat = URLComponents(url: chatURL, resolvingAgainstBaseURL: false),
      let managementScheme = management.scheme?.lowercased(),
      let chatScheme = chat.scheme?.lowercased(),
      let managementHost = management.host,
      let chatHost = chat.host,
      managementHost == chatHost,
      (managementScheme == "http" && chatScheme == "ws")
        || (managementScheme == "https" && chatScheme == "wss"),
      management.path.isEmpty || management.path == "/",
      chat.path == "/ws/chat",
      management.query == nil,
      chat.query == nil,
      management.fragment == nil,
      chat.fragment == nil,
      management.user == nil,
      management.password == nil,
      chat.user == nil,
      chat.password == nil
    else {
      throw LiveGatewayEnvironmentError.incompatibleEndpoints
    }

    let secure = managementScheme == "https"
    let profile = ConnectionProfile(
      id: UUID(),
      gatewayId: gatewayID,
      publicKey: nil,
      label: "Live gateway integration",
      host: managementHost,
      managementPort: management.port ?? (secure ? 443 : 80),
      chatPort: chat.port ?? (secure ? 443 : 80),
      secure: secure,
      mode: .lan,
      createdAt: Date(),
      lastSuccessfulSyncAt: nil
    )
    let secrets = ConnectionSecrets(
      managementToken: managementToken,
      chatToken: chatToken,
      relayCredential: nil
    )
    return ConnectionEndpoint(profile: profile, secrets: secrets)
  }

  private static func required(_ name: String, in values: [String: String]) throws -> String {
    guard let value = values[name] else {
      throw LiveGatewayEnvironmentError.missing(name)
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.isEmpty == false else {
      throw LiveGatewayEnvironmentError.blank(name)
    }
    return trimmed
  }

  private static func absoluteURL(_ value: String, name: String) throws -> URL {
    guard
      let components = URLComponents(string: value),
      components.scheme?.isEmpty == false,
      components.host?.isEmpty == false,
      let url = components.url
    else {
      throw LiveGatewayEnvironmentError.invalidURL(name)
    }
    return url
  }
}

final class LiveGatewayClient: Sendable {
  let environment: LiveGatewayEnvironment
  let endpoint: ConnectionEndpoint
  let secrets: ConnectionSecrets
  let transport: HTTPTransport
  let api: GatewayAPI
  let sse: SSEClient
  let chat: ChatConnection
  let store: PersistenceStore
  let sync: ConversationSyncEngine

  var conversationStore: PersistenceStore { store }
  var syncStore: PersistenceStore { store }

  init(
    environment: LiveGatewayEnvironment,
    endpoint: ConnectionEndpoint,
    secrets: ConnectionSecrets,
    transport: HTTPTransport,
    api: GatewayAPI,
    sse: SSEClient,
    chat: ChatConnection,
    store: PersistenceStore,
    sync: ConversationSyncEngine
  ) {
    self.environment = environment
    self.endpoint = endpoint
    self.secrets = secrets
    self.transport = transport
    self.api = api
    self.sse = sse
    self.chat = chat
    self.store = store
    self.sync = sync
  }

  func rebuiltOverSharedStore() throws -> LiveGatewayClient {
    try environment.makeClient(store: store)
  }
}

enum LiveGatewayTestError: Error, Equatable, Sendable {
  case timeout
  case streamFinished
  case unexpectedFailure
}

struct LiveInvalidationRetryPolicy: Sendable {
  let maxAttempts: Int
  let observationTimeout: Duration

  init(maxAttempts: Int, observationTimeout: Duration) {
    precondition(maxAttempts > 0)
    self.maxAttempts = maxAttempts
    self.observationTimeout = observationTimeout
  }

  func run(
    initialRevision: Int,
    mutate: @escaping @Sendable (_ revision: Int, _ attempt: Int) async throws -> Int,
    observe: @escaping @Sendable (_ revision: Int, _ timeout: Duration) async throws -> Bool
  ) async throws -> Int {
    var revision = initialRevision
    for attempt in 1...maxAttempts {
      revision = try await mutate(revision, attempt)
      if try await observe(revision, observationTimeout) { return revision }
    }
    throw LiveGatewayTestError.timeout
  }
}

actor LiveChatRecorder {
  private var recordedFrames: [MobileWSServerFrame] = []
  private var recordedStates: [ChatTransportState] = []
  private var terminalError: GatewayError?
  private var isFinished = false

  func append(_ event: ChatConnectionEvent) {
    switch event {
    case .state(let state):
      recordedStates.append(state)
    case .frame(let frame):
      recordedFrames.append(frame)
    }
  }

  func fail(_ error: GatewayError) {
    terminalError = error
    isFinished = true
  }

  func finish() {
    isFinished = true
  }

  func frames(turnID: String) -> [MobileWSServerFrame] {
    recordedFrames.filter { $0.liveTurnID == turnID }
  }

  func waitForFrame(
    turnID: String,
    timeout: Duration = .seconds(15),
    matching predicate: @escaping @Sendable (MobileWSServerFrame) -> Bool
  ) async throws -> MobileWSServerFrame {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
      if let frame = recordedFrames.first(where: {
        $0.liveTurnID == turnID && predicate($0)
      }) {
        return frame
      }
      if let terminalError { throw terminalError }
      if isFinished { throw LiveGatewayTestError.streamFinished }
      try await clock.sleep(for: .milliseconds(20))
    }
    throw LiveGatewayTestError.timeout
  }

  func waitForFailure(timeout: Duration = .seconds(15)) async throws -> GatewayError {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
      if let terminalError { return terminalError }
      if isFinished { throw LiveGatewayTestError.streamFinished }
      try await clock.sleep(for: .milliseconds(20))
    }
    throw LiveGatewayTestError.timeout
  }
}

final class LiveChatRecording: Sendable {
  let recorder: LiveChatRecorder
  private let worker: Task<Void, Never>

  private init(recorder: LiveChatRecorder, worker: Task<Void, Never>) {
    self.recorder = recorder
    self.worker = worker
  }

  static func start(
    chat: ChatConnection,
    sync: ConversationSyncEngine? = nil,
    agentID: String? = nil
  ) async -> LiveChatRecording {
    let stream = await chat.events()
    let recorder = LiveChatRecorder()
    let worker = Task {
      do {
        for try await event in stream {
          await recorder.append(event)
          if case .frame(let frame) = event, let sync, let agentID {
            await sync.consumeLiveFrame(frame, agentID: agentID)
          }
        }
        await recorder.finish()
      } catch let error as GatewayError {
        await recorder.fail(error)
      } catch is CancellationError {
        await recorder.finish()
      } catch {
        await recorder.fail(.transport("Chat recording failed"))
      }
    }
    return LiveChatRecording(recorder: recorder, worker: worker)
  }

  func cancel() {
    worker.cancel()
  }

  func finished() async {
    await worker.value
  }
}

actor LiveInvalidationRecorder {
  private var events: [GatewayInvalidationEvent] = []
  private var terminalError: GatewayError?
  private var isFinished = false

  func append(_ event: GatewayInvalidationEvent) {
    events.append(event)
  }

  func fail(_ error: GatewayError) {
    terminalError = error
    isFinished = true
  }

  func finish() {
    isFinished = true
  }

  func waitFor(
    timeout: Duration = .seconds(15),
    matching predicate: @escaping @Sendable (GatewayInvalidationEvent) -> Bool
  ) async throws -> GatewayInvalidationEvent {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
      if let event = events.first(where: predicate) { return event }
      if let terminalError { throw terminalError }
      if isFinished { throw LiveGatewayTestError.streamFinished }
      try await clock.sleep(for: .milliseconds(20))
    }
    throw LiveGatewayTestError.timeout
  }
}

final class LiveInvalidationRecording: Sendable {
  let recorder: LiveInvalidationRecorder
  private let worker: Task<Void, Never>

  private init(recorder: LiveInvalidationRecorder, worker: Task<Void, Never>) {
    self.recorder = recorder
    self.worker = worker
  }

  static func start(_ client: SSEClient) async -> LiveInvalidationRecording {
    let stream = await client.events()
    let recorder = LiveInvalidationRecorder()
    let worker = Task {
      do {
        for try await event in stream {
          await recorder.append(event)
        }
        await recorder.finish()
      } catch let error as GatewayError {
        await recorder.fail(error)
      } catch is CancellationError {
        await recorder.finish()
      } catch {
        await recorder.fail(.transport("Invalidation recording failed"))
      }
    }
    return LiveInvalidationRecording(recorder: recorder, worker: worker)
  }

  func cancel() {
    worker.cancel()
  }
}

actor LiveSyncRecorder {
  private var snapshots: [SyncSnapshot] = []
  private var isFinished = false

  func append(_ snapshot: SyncSnapshot) {
    snapshots.append(snapshot)
  }

  func finish() {
    isFinished = true
  }

  func waitFor(
    timeout: Duration = .seconds(15),
    matching predicate: @escaping @Sendable (SyncSnapshot) -> Bool
  ) async throws -> SyncSnapshot {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
      if let snapshot = snapshots.first(where: predicate) { return snapshot }
      if isFinished { throw LiveGatewayTestError.streamFinished }
      try await clock.sleep(for: .milliseconds(20))
    }
    throw LiveGatewayTestError.timeout
  }
}

final class LiveSyncRecording: Sendable {
  let recorder: LiveSyncRecorder
  private let worker: Task<Void, Never>

  private init(recorder: LiveSyncRecorder, worker: Task<Void, Never>) {
    self.recorder = recorder
    self.worker = worker
  }

  static func start(_ sync: ConversationSyncEngine) async -> LiveSyncRecording {
    let stream = await sync.snapshots()
    let recorder = LiveSyncRecorder()
    let worker = Task {
      for await snapshot in stream {
        await recorder.append(snapshot)
      }
      await recorder.finish()
    }
    return LiveSyncRecording(recorder: recorder, worker: worker)
  }

  func cancel() {
    worker.cancel()
  }
}

extension MobileWSServerFrame {
  fileprivate var liveTurnID: String {
    switch self {
    case .accepted(let id, _, _, _, _, _),
      .event(let id, _, _, _),
      .done(let id, _, _, _),
      .error(let id, _, _, _, _, _, _):
      return id
    }
  }
}
