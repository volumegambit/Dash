import AVFoundation
import Foundation

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
        let dataIdentifier =
          environment["DASH_UI_TEST_DATA_IDENTIFIER"]
          ?? arguments.uiTestValue(after: "--dash-ui-test-data-identifier")
          ?? UUID().uuidString
        return AppDependenciesFactory {
          guard let scenario = UITestScenario(rawValue: rawScenario) else {
            throw UITestScenarioError.unsupported(rawScenario)
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
  /// Debug-only launch options that put a specific screen on-screen without a
  /// test runner (UI-quality goal, Phase B).
  ///
  /// Most of this app's surfaces could not be looked at. `simctl` has no tap
  /// command, `devicectl` has no screenshot subcommand, the `dash://` scheme
  /// only handles `oauth-callback`, and `AppModel.selectedTab` is plain
  /// in-memory state — so the only reachable screen was whatever the app
  /// happened to launch into. Three redesigned screens shipped on 2026-09-05
  /// verified by assertions alone because of it.
  ///
  /// With this, `simctl launch` plus `simctl io <udid> screenshot` captures
  /// any tab:
  ///
  ///     SIMCTL_CHILD_DASH_UI_TEST_SCENARIO=paired-online \
  ///     SIMCTL_CHILD_DASH_UI_TEST_TAB=settings \
  ///     xcrun simctl launch <udid> app.dash.ios
  ///
  /// `#if DEBUG` like the scenario support it sits beside, so it cannot
  /// affect a Release build.
  enum UITestLaunchOptions {
    /// A conversation to open on launch, so the chat surface — the one that
    /// needs a tap to reach and therefore could not be captured at all — is
    /// reachable from `simctl`. Takes precedence over `initialTab`, since
    /// opening a conversation implies the Conversations tab.
    static var initialConversationID: String? {
      let environment = ProcessInfo.processInfo.environment
      return environment["DASH_UI_TEST_CONVERSATION"]
        ?? ProcessInfo.processInfo.arguments.uiTestValue(after: "--dash-ui-test-conversation")
    }

    /// An agent to open on launch, so agent detail — reachable only by
    /// selecting a row — can be captured.
    static var initialAgentID: String? {
      let environment = ProcessInfo.processInfo.environment
      return environment["DASH_UI_TEST_AGENT"]
        ?? ProcessInfo.processInfo.arguments.uiTestValue(after: "--dash-ui-test-agent")
    }

    /// A sheet to present on launch. Sheets are view state, not `AppModel`
    /// state, so the presenting view reads this itself — see `ChatView`.
    /// Values: `model-picker`.
    static var initialSheet: String? {
      let environment = ProcessInfo.processInfo.environment
      return environment["DASH_UI_TEST_SHEET"]
        ?? ProcessInfo.processInfo.arguments.uiTestValue(after: "--dash-ui-test-sheet")
    }

    static var initialTab: AppTab? {
      guard let raw = rawInitialTab else { return nil }
      // `settings-speech` is a ROUTE, not a tab: it lands on Settings and
      // pushes Settings > Speech. Kept in this one option rather than a
      // second variable because a capture asks for a surface, and Speech is
      // one of Settings' surfaces.
      if raw == speechSettingsTab { return .settings }
      return AppTab(rawValue: raw)
    }

    /// Whether the launch asked for Settings > Speech, the one screen in
    /// Settings that is behind a tap and so unreachable from `simctl`.
    /// `SettingsView` reads this and pushes the screen itself, since a
    /// pushed detail view is view state rather than `AppModel` state.
    static var opensSpeechSettings: Bool {
      rawInitialTab == speechSettingsTab
    }

    private static let speechSettingsTab = "settings-speech"

    private static var rawInitialTab: String? {
      ProcessInfo.processInfo.environment["DASH_UI_TEST_TAB"]
        ?? ProcessInfo.processInfo.arguments.uiTestValue(after: "--dash-ui-test-tab")
    }

    /// Start every tool card expanded, so a capture can show the tool BODIES.
    ///
    /// The same gap `initialConversationID` closed one level down: a tool
    /// card's body is behind a tap, `simctl` has no tap, and so the per-tool
    /// result rendering — the thing the 2026-09-05 tool-use goal is about —
    /// could not be looked at on any iOS screen. Collapsed rows were
    /// auditable; the bodies were not.
    /// Which batch of the tool gallery to render in the chat fixture, or nil
    /// for the ordinary fixture. Four batches, because a phone screen fits
    /// about four EXPANDED tool cards and the point is to see the bodies.
    static var toolGallery: String? {
      let environment = ProcessInfo.processInfo.environment
      return environment["DASH_UI_TEST_TOOL_GALLERY"]
        ?? ProcessInfo.processInfo.arguments.uiTestValue(after: "--dash-ui-test-tool-gallery")
    }

    /// Seeds the composer's dictation state: `recording`, `uploading` or
    /// `failed`. Like `toolGallery`, this exists because the states behind it
    /// are unreachable from `simctl` — dictation needs a tap, a microphone
    /// and a gateway — so none of the three could be looked at on any screen.
    ///
    /// It drives the REAL `DictationFeature` through the UI-test fakes below
    /// rather than writing a phase, so a capture cannot show a state the app
    /// is unable to reach.
    static var dictation: String? {
      let environment = ProcessInfo.processInfo.environment
      return environment["DASH_UI_TEST_DICTATION"]
        ?? ProcessInfo.processInfo.arguments.uiTestValue(after: "--dash-ui-test-dictation")
    }

    /// Opens the hands-free voice cover and drives it into one state:
    /// `listening`, `thinking`, `speaking`, `muted` or `ended`. Same reason
    /// `dictation` exists — every one of those needs a tap, a microphone, a
    /// speech provider and a live socket, so none of them could be looked at
    /// on any screen before this.
    static var voice: String? {
      let environment = ProcessInfo.processInfo.environment
      return environment["DASH_UI_TEST_VOICE"]
        ?? ProcessInfo.processInfo.arguments.uiTestValue(after: "--dash-ui-test-voice")
    }

    static var expandTools: Bool {
      let environment = ProcessInfo.processInfo.environment
      if let raw = environment["DASH_UI_TEST_EXPAND_TOOLS"] {
        return raw == "1" || raw.lowercased() == "true"
      }
      return ProcessInfo.processInfo.arguments.contains("--dash-ui-test-expand-tools")
    }
  }

  extension Array where Element == String {
    fileprivate func uiTestValue(after option: String) -> String? {
      guard let index = firstIndex(of: option) else { return nil }
      let valueIndex = index + 1
      guard indices.contains(valueIndex) else { return nil }
      return self[valueIndex]
    }
  }

  /// Whether `ChatView` should render its `chat.scrollAnchor` probe — the
  /// only way a UI test can observe that `.scrollPosition(id:)` is genuinely
  /// tracking real `ChatMessageState.id`s (Task 4 review fix, Important 1).
  /// Scoped to the single scenario that needs it, so no other UI suite ever
  /// sees the extra accessibility element.
  enum UITestProbe {
    @MainActor
    static let isScrollAnchorProbeEnabled: Bool = {
      let environment = ProcessInfo.processInfo.environment
      let arguments = ProcessInfo.processInfo.arguments
      let raw =
        environment["DASH_UI_TEST_SCENARIO"]
        ?? arguments.uiTestValue(after: "--dash-ui-test-scenario")
      return raw == UITestScenario.longTranscript.rawValue
    }()

    /// Whether this process is running a UI-test scenario at all. Used by
    /// `ConversationWindowSceneGuard` to close conversation windows that
    /// iPadOS RESTORED from a previous run's scene session.
    ///
    /// Why this exists: scene sessions outlive the app, and
    /// `XCUIApplication.terminate()` does NOT destroy them. Measured on the
    /// iPad 26.5 simulator, a run that opens a conversation window leaves
    /// that scene behind, and the NEXT launch comes up with the chat-only
    /// window frontmost and the main window demoted to "1 Hidden Window" —
    /// which broke the two `IPadUITests` cases that happened to run next
    /// (6 tests, 2 failures) even though nothing was wrong with the app.
    /// Every other piece of cross-launch state the suite depends on is
    /// already isolated per launch by `DASH_UI_TEST_DATA_IDENTIFIER`; scene
    /// sessions are the one thing that identifier cannot reach.
    ///
    /// Deliberately NOT a change to shipping behaviour: restoring the
    /// last-used window is what iPadOS does for every multi-window app, and
    /// Dash keeps doing it in Release. This only makes the UI-test harness's
    /// "each launch starts from the main window" assumption true.
    @MainActor
    static let isRunningUITestScenario: Bool = {
      let environment = ProcessInfo.processInfo.environment
      let arguments = ProcessInfo.processInfo.arguments
      return environment["DASH_UI_TEST_SCENARIO"] != nil
        || arguments.uiTestValue(after: "--dash-ui-test-scenario") != nil
    }()
  }

  enum UITestScenarioError: Error, Equatable, Sendable {
    case unsupported(String)
  }

  enum UITestScenario: String, CaseIterable, Sendable {
    case unpaired
    case pairedOnline = "paired-online"
    case pairedOffline = "paired-offline"
    case streamingReconnect = "streaming-reconnect"
    case remoteBusy = "remote-busy"
    case pendingRecovery = "pending-recovery"
    case activeRecovery = "active-recovery"
    case agents
    /// Compose-first new chat (Task 3, audit #16): agents are seeded but NO
    /// conversation exists yet, unlike every other paired scenario (which
    /// all start with `sharedConversation` already bound to `research-agent`
    /// — see `UITestScenarioStore.init`). Tapping compose here always
    /// produces a genuinely fresh, empty conversation instead of the fake
    /// store's create-dedups-by-agent shortcut (`UITestScenarioStore.create`)
    /// silently reopening a pre-existing, already-populated thread.
    case composeNewChat = "compose-new-chat"
    case settingsForget = "settings-forget"
    /// Signed-out entry point (`SignInView`) — functionally identical to
    /// `.unpaired`, kept as its own case so `AccountUITests` reads
    /// independently of the older pairing-flow suite.
    case signedOut = "signed-out"
    /// Signed in, account has one enrolled gateway that loads successfully;
    /// tapping it runs the full connect pipeline through to `RootView`'s
    /// paired content.
    case accountPicker = "account-picker"
    /// Signed in, but `GET /v1/gateways` fails — exercises `.error` state
    /// (CP-unreachable copy + `account.retry`).
    case accountPickerError = "account-picker-error"
    /// Signed in, one enrolled gateway loads, but connecting mints a grant
    /// with no `chatToken` — exercises `AccountConnectError.notEnrolled`.
    case accountNotEnrolled = "account-not-enrolled"
    /// Signed in AND already paired (so `SettingsView`'s "Approve a device"
    /// row is reachable), with a scripted `ControlPlaneClient` (approvals
    /// routes) and a fake `QRScanning` that hands back a canned
    /// `dash-approve:v1:` payload instead of requiring a camera — see
    /// `AccountUITests`.
    case approveDevice = "approve-device"
    /// Transcript-scrolling scenarios (2026-09-05): `sharedConversation` seeded
    /// with 40 cached messages (ordinals 11–50, enough to overflow any
    /// supported viewport, iPad landscape included), a further 10-message
    /// page (ordinals 1–10) behind `longTranscriptOlderCursor` for "Load
    /// earlier", and a send that streams 90 text deltas over ~11s so a UI test
    /// can scroll mid-stream. Every other scenario keeps its 2-message thread.
    ///
    /// MERGE NOTE (2026-09-07): two sessions independently created a
    /// `long-transcript` scenario for the same reason — `.pairedOnline`'s
    /// two-message fixture cannot overflow a viewport, so there is nothing to
    /// scroll away from, and adding filler to `.pairedOnline` was tried once
    /// and broke every test built on the shared fixture. They are now ONE
    /// case backed by main's fixture, which is a strict superset of the iPad
    /// branch's 40 all-`user` `filler-` rows: it has the same 40 visible
    /// messages plus a second page for "Load earlier" and an ~11s streamed
    /// reply. `IPadUITests.testScrollingAwayFromTheBottomSurvivesRotation`
    /// was repointed from the `filler-` id prefix to `long-` accordingly.
    ///
    /// It is also the only scenario that renders the `chat.scrollAnchor`
    /// probe (`ChatView.scrollAnchorProbe`), so no other suite sees an extra
    /// accessibility element.
    case longTranscript = "long-transcript"

    /// Explicit enumeration (rather than `self != .unpaired`) so adding a new
    /// signed-out-first case can't silently start it paired by omission.
    var startsPaired: Bool {
      switch self {
      case .pairedOnline, .pairedOffline, .streamingReconnect, .remoteBusy,
        .pendingRecovery, .activeRecovery, .agents, .composeNewChat, .settingsForget,
        .approveDevice, .longTranscript:
        return true
      case .unpaired, .signedOut, .accountPicker, .accountPickerError, .accountNotEnrolled:
        return false
      }
    }

    var connection: GatewayConnectionState {
      self == .pairedOffline ? .offline : .online
    }

    /// What this scenario's fake gateway advertises.
    ///
    /// Only `.pairedOnline` carries `speech-v1`, which is what makes the
    /// composer's mic testable in BOTH directions: every other scenario —
    /// `.pairedOffline` in particular — stands in for a gateway that has no
    /// speech provider, where `chat.dictate` must not exist at all.
    var capabilities: Set<MobileCapability> {
      var advertised: Set<MobileCapability> = [.conversationSyncV1, .chatResumeV1]
      if self == .pairedOnline {
        advertised.insert(.speechV1)
      }
      return advertised
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

    static let deletedConversation = ConversationSummaryDTO(
      id: "deleted-plan",
      agentId: "research-agent",
      agentName: "Research Agent",
      title: "Deleted launch plan",
      revision: 2,
      status: .deleted,
      activeTurnId: nil,
      owningIssueId: nil,
      projectId: nil,
      lastSeq: 0,
      lastMessagePreview: nil,
      createdAt: now.addingTimeInterval(-600),
      updatedAt: now,
      deletedAt: now
    )

    static let recoveredPendingSend = PendingChatSend(
      turnID: "pending-recovery-turn",
      localUserID: "pending-recovery-user",
      draft: "  Preserve this exact recovery text  ",
      attachments: [
        PreparedAttachment(
          id: UUID(uuidString: "018F0F4A-5C42-7A8B-9C01-1234567890AB")!,
          mediaType: "image/png",
          data: Data(
            base64Encoded:
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8A"
              + "AQUBAScY42YAAAAASUVORK5CYII="
          )!
        ),
        PreparedAttachment(
          id: UUID(uuidString: "018F0F4A-5C42-7A8B-9C01-1234567890AC")!,
          mediaType: "image/jpeg",
          data: Data([0xFF, 0xD8, 0xFF])
        )
      ],
      createdAt: now.addingTimeInterval(-60)
    )

    static let recoveredNewerDraftText =
      "  Preserve this exact newer draft text too through a "
      + "horizontally scrolling composer  "

    static let recoveredNewerDraft = ConversationDraft(
      text: recoveredNewerDraftText,
      attachments: [
        PreparedAttachment(
          id: UUID(uuidString: "018F0F4A-5C42-7A8B-9C01-1234567890AD")!,
          mediaType: "image/png",
          data: Data(
            base64Encoded:
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8A"
              + "AQUBAScY42YAAAAASUVORK5CYII="
          )!
        )
      ],
      updatedAt: now.addingTimeInterval(-30)
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

    /// Agent memory (Task 19): seeded per agent so the detail screen's
    /// Memory section has both a `user` and a `project` bucket to group.
    static let skills: [String: [SkillDTO]] = [
      "research-agent": [
        SkillDTO(
          name: "write-files",
          description: "Use when writing files in this project",
          trigger: nil,
          source: .agent,
          content: "- Always use printf instead of echo when writing files."
        ),
        SkillDTO(
          name: "deep-research",
          description: "Use for multi-source research tasks",
          trigger: "research",
          source: .plugin,
          content: nil
        ),
      ]
    ]

    static let memories: [String: [MemoryInfoDTO]] = [
      "research-agent": [
        memory(
          name: "user-timezone",
          description: "Gerry is in Singapore (UTC+8)",
          type: .user,
          source: "agent",
          size: 24
        ),
        memory(
          name: "repo-pnpm",
          description: "The repo uses pnpm",
          type: .project,
          source: "sweep",
          size: 18
        ),
      ]
    ]

    static func memory(
      name: String,
      description: String,
      type: MemoryTypeDTO,
      source: String,
      size: Int
    ) -> MemoryInfoDTO {
      MemoryInfoDTO(
        name: name,
        description: description,
        type: type,
        source: source,
        createdAt: "2026-09-05",
        updatedAt: "2026-09-05",
        size: size
      )
    }

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
      if scenario == .pendingRecovery { return deletedConversation }
      guard scenario == .remoteBusy else { return sharedConversation }
      return copy(
        sharedConversation,
        revision: 2,
        status: .running,
        activeTurnID: "remote-ui-turn",
        lastSequence: 2
      )
    }

    static let onePixelPNG =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="

    /// `.longTranscript` paging: the cursor the canonical refresh hands back
    /// for the 40-message recent page; `refresh(before: thisCursor)` serves
    /// `longTranscriptOlderMessages` with no further cursor.
    static let longTranscriptOlderCursor = "long-transcript-older"
    static let longTranscriptOldestVisibleOrdinal = 11
    static let longTranscriptNewestOrdinal = 50

    /// Ordinals 11–50: 20 turns. Assistant replies rotate through a short
    /// paragraph, a bulleted list, a fenced code block and a two-paragraph
    /// answer so row heights vary the way a real thread's do (that is what
    /// makes a lazy stack's scroll landing inexact).
    static let longTranscriptMessages: [ConversationMessageDTO] = longTranscriptTurns(
      ordinals: longTranscriptOldestVisibleOrdinal...longTranscriptNewestOrdinal
    )

    /// Ordinals 1–10: the page behind `longTranscriptOlderCursor`.
    static let longTranscriptOlderMessages: [ConversationMessageDTO] = longTranscriptTurns(
      ordinals: 1...(longTranscriptOldestVisibleOrdinal - 1)
    )

    private static func longTranscriptTurns(ordinals: ClosedRange<Int>) -> [ConversationMessageDTO] {
      ordinals.map { ordinal in
        let turn = (ordinal + 1) / 2
        if ordinal.isMultiple(of: 2) == false {
          return message(
            id: "long-user-\(ordinal)",
            turnID: "long-turn-\(turn)",
            role: .user,
            status: .completed,
            text: "Question \(turn): what should we check before the launch?",
            ordinal: ordinal
          )
        }
        let body: String
        switch turn % 4 {
        case 0:
          body = "Reply \(turn). Verify the rollout checklist and confirm the on-call rota."
        case 1:
          body = "Reply \(turn).\n\n- Confirm the rollout checklist\n- Page the on-call engineer\n- Freeze deploys for the window\n- Re-run the smoke suite"
        case 2:
          body = "Reply \(turn). Run this first:\n\n```bash\nnpm run build\nnpm test -- --run\nnpm run smoke -- --env=staging\n```\n\nThen watch the error budget for ten minutes."
        default:
          body = "Reply \(turn). The launch plan holds as long as the error budget stays above the floor and the on-call engineer has acknowledged the page.\n\nIf either slips, hold the rollout and re-run the smoke suite before trying again."
        }
        return message(
          id: "long-assistant-\(ordinal)",
          turnID: "long-turn-\(turn)",
          role: .assistant,
          status: .completed,
          events: [
            .response(
              content: body,
              usage: UsageDTO(inputTokens: 8, outputTokens: 40, cacheReadTokens: nil, cacheWriteTokens: nil)
            )
          ],
          ordinal: ordinal
        )
      }
    }

    /// The `.longTranscript` send's reply, streamed as 90 deltas ~120ms apart
    /// (≈11s): long enough that a UI test — with XCUITest's several seconds
    /// of idle-waiting after the send, more on the iOS 18.4 CI runtime —
    /// still drags AND taps jump-to-latest while the reply is streaming. (At
    /// 7s the tap coincided with completion on 18.4, and the composer
    /// re-enabling brought the keyboard back under the tap.)
    static let longTranscriptStreamedReply: String = {
      (1...90).map { "Streamed chunk \($0) of the reply." }.joined(separator: " ")
    }()

    /// One assistant message per gallery batch, so `capture-surfaces.sh` can
    /// render every tool type's BODY and the per-type result treatment can be
    /// audited from pixels rather than from reading `resultView`.
    ///
    /// Single-line string literals with escapes throughout, deliberately: a
    /// Swift `"""` block would be re-indented by the formatter and the
    /// leading whitespace of a numbered-source fixture is load-bearing.
    static func toolGalleryMessages(_ batch: String) -> [ConversationMessageDTO] {
      let events: [AgentEvent]
      switch batch {
      case "files":
        events = [
          .toolUseStart(
            id: "g-read", name: "read",
            input: .object(["path": .string("apps/web/src/ui/blocks/tool-presentation.ts")])),
          .toolResult(
            id: "g-read", name: "read",
            content:
              "<path>apps/web/src/ui/blocks/tool-presentation.ts</path>\n<content>\n   1\texport function normalizeTool(name: string): string {\n   2\t  switch (name) {\n   3\t    case 'read_file':\n   4\t      return 'read';\n   5\t    default:\n   6\t      return name;\n   7\t  }\n   8\t}\n</content>",
            isError: false, details: nil),
          .toolUseStart(
            id: "g-write", name: "write",
            input: .object([
              "path": .string("docs/notes.md"),
              "content": .string("# Notes\n\nFirst line.\nSecond line.\n"),
            ])),
          .toolResult(
            id: "g-write", name: "write", content: "Wrote 4 lines to docs/notes.md",
            isError: false, details: nil),
          .toolUseStart(
            id: "g-edit", name: "edit",
            input: .object(["path": .string("apps/web/src/ui/blocks/ContentBlocks.tsx")])),
          .toolResult(
            id: "g-edit", name: "edit", content: "ok", isError: false,
            details: .object([
              "diff": .string(
                "--- a/apps/web/src/ui/blocks/ContentBlocks.tsx\n+++ b/apps/web/src/ui/blocks/ContentBlocks.tsx\n@@ -12,7 +12,8 @@\n   const summary = summarize(tool.name, tool.input);\n-  const details = formatVisibleDetails(tool.name, tool.input);\n+  const outcome = resultSummary(tool.name, result?.content);\n+  const details = formatVisibleDetails(tool.name, tool.input);")
            ])),
        ]
      case "shell":
        events = [
          .toolUseStart(
            id: "g-bash", name: "bash",
            input: .object(["command": .string("/opt/homebrew/bin/npm run lint")])),
          .toolResult(
            id: "g-bash", name: "bash",
            content:
              "> dash@0.2.0 lint\n> biome check .\n\nChecked 942 files in 609ms. No fixes applied.",
            isError: false, details: nil),
          .toolUseStart(
            id: "g-quiet", name: "bash",
            input: .object(["command": .string("mkdir -p build/captures")])),
          .toolResult(id: "g-quiet", name: "bash", content: "", isError: false, details: nil),
          .toolUseStart(id: "g-ls", name: "ls", input: .object(["path": .string("apps/web/src")])),
          .toolResult(
            id: "g-ls", name: "ls",
            content: "(5 entries)\nui/\nintegration/\nmain.tsx\nstyles.css\nvite-env.d.ts",
            isError: false, details: nil),
        ]
      case "search":
        events = [
          .toolUseStart(
            id: "g-grep", name: "grep", input: .object(["pattern": .string("resultSummary")])),
          .toolResult(
            id: "g-grep", name: "grep",
            content:
              "apps/web/src/ui/blocks/tool-presentation.ts:214: export function resultSummary(\napps/web/src/ui/blocks/ContentBlocks.tsx:191:  const outcome = resultSummary(\nios/Dash/Features/Conversations/ToolPresentation.swift:318:  static func resultSummary(",
            isError: false, details: nil),
          .toolUseStart(
            id: "g-search", name: "web_search",
            input: .object(["query": .string("swiftui observable macro")])),
          .toolResult(
            id: "g-search", name: "web_search",
            content:
              "1. [Observation | Apple Developer](https://developer.apple.com/documentation/observation)\n   The Observation framework provides a robust, type-safe model.\n\n2. [Migrating to the Observable macro](https://developer.apple.com/videos/wwdc)\n   Replace ObservableObject with the @Observable macro.",
            isError: false, details: nil),
          .toolUseStart(
            id: "g-fetch", name: "web_fetch",
            input: .object([
              "url": .string("https://developer.apple.com/documentation/observation")
            ])),
          .toolResult(
            id: "g-fetch", name: "web_fetch",
            content: String(repeating: "Observation framework documentation body. ", count: 40),
            isError: false, details: nil),
        ]
      default:
        events = [
          .toolUseStart(
            id: "g-todo", name: "TodoWrite",
            input: .object([
              "todos": .array([
                .object([
                  "content": .string("Port resultSummary to iOS"), "status": .string("completed"),
                ]),
                .object([
                  "content": .string("Audit each tool type from a rendered screen"),
                  "status": .string("in_progress"),
                ]),
                .object([
                  "content": .string("Write the per-type design"), "status": .string("pending"),
                ]),
              ])
            ])),
          .toolResult(id: "g-todo", name: "TodoWrite", content: "ok", isError: false, details: nil),
          .toolUseStart(
            id: "g-skill", name: "load_skill",
            input: .object(["name": .string("frontend-design")])),
          .toolResult(
            id: "g-skill", name: "load_skill", content: "Loaded skill 'frontend-design'.",
            isError: false, details: nil),
          .toolUseStart(
            id: "g-mcp", name: "linear__search_issues",
            input: .object([
              "query": .string("tool card"), "limit": .number(5),
              "filter": .object(["state": .string("open")]),
            ])),
          .toolResult(
            id: "g-mcp", name: "linear__search_issues",
            content: "DASH-412  Tool rows unreadable\nDASH-418  Diff not rendered on iOS",
            isError: false, details: nil),
          .toolUseStart(
            id: "g-fail", name: "read",
            input: .object(["path": .string("/Users/gerry/missing.swift")])),
          .toolResult(
            id: "g-fail", name: "read", content: "ENOENT: no such file or directory",
            isError: true, details: nil),
          .toolUseStart(
            id: "g-run", name: "bash", input: .object(["command": .string("npm test")])),
        ]
      }
      return [
        message(
          id: "gallery-assistant", turnID: "gallery-turn", role: .assistant, status: .completed,
          events: events, ordinal: 1)
      ]
    }

    /// The id of the scripted NOTIFICATION turn on the parent conversation.
    ///
    /// §8.5's row: the gateway starts a turn on the orchestrator's own
    /// conversation to wake it with a background child's result, and the body
    /// is a machine-written `<subagent-result>` envelope the user never typed.
    /// It exists so `chat.notification.<messageId>` — named in the D5 brief's
    /// identifier list and in its Step 1 — is queried by something. Before
    /// this, `NotificationRowView` was reachable in the app and rendered by no
    /// test at any level.
    static let notificationID = "ui-notification"

    static func cachedMessages(for scenario: UITestScenario) -> [ConversationMessageDTO] {
      #if DEBUG
        if let batch = UITestLaunchOptions.toolGallery {
          return toolGalleryMessages(batch)
        }
      #endif
      if scenario == .streamingReconnect {
        return [
          message(
            id: notificationID,
            turnID: "ui-notification-turn",
            role: .user,
            status: .completed,
            // `<summary>` on purpose: `notificationRowLabel` prefers it over
            // the sender form and over the fallback, so the rendered label is
            // deterministic and the UI test can assert the SUMMARY rather than
            // the envelope.
            text:
              "[SYSTEM NOTIFICATION - NOT USER INPUT]\n"
              + "<subagent-result id=\"ui-subagent\">"
              + "<summary>researcher finished the launch checklist review</summary>"
              + "</subagent-result>",
            ordinal: 1,
            origin: MessageOrigin.notification.rawValue
          )
        ]
      }
      if scenario == .pendingRecovery { return [] }
      if scenario == .longTranscript { return longTranscriptMessages }
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
          // Phase 4 Task 4 (audit #19): a decodable 1x1 PNG so the
          // thumbnail → full-screen viewer path is exercised by UI tests.
          images: [MessageImage(mediaType: .png, data: onePixelPNG)],
          ordinal: 1
        ),
        message(
          id: "cached-assistant",
          turnID: "cached-turn",
          role: .assistant,
          status: .completed,
          events: [
            // Tool-use UX (2026-09-05): a run of four calls — a plain
            // success, a grep with a countable result, an edit carrying a
            // diff, and a failure — so `capture-surfaces.sh`'s `chat` shot
            // actually shows the tool rows. Before this the only reachable
            // chat capture had no tool calls in it at all, which is how three
            // screens shipped in the first place without being looked at.
            .toolUseStart(
              id: "cap-1", name: "bash",
              input: .object(["command": .string("/opt/homebrew/bin/npm run build")])),
            .toolResult(
              id: "cap-1", name: "bash", content: "built in 4.2s", isError: false, details: nil),
            .toolUseStart(
              id: "cap-2", name: "grep", input: .object(["pattern": .string("resultSummary")])),
            .toolResult(
              id: "cap-2", name: "grep",
              content: "a.ts:1: hit\nb.ts:9: hit\nc.ts:14: hit", isError: false, details: nil),
            .toolUseStart(
              id: "cap-3", name: "edit",
              input: .object(["path": .string("apps/web/src/ui/blocks/ContentBlocks.tsx")])),
            .toolResult(
              id: "cap-3", name: "edit", content: "ok", isError: false,
              details: .object(["diff": .string("--- a/x\n+++ b/x\n-old\n+new\n+more")])),
            .toolUseStart(
              id: "cap-4", name: "read",
              input: .object(["path": .string("/Users/gerry/missing.swift")])),
            .toolResult(
              id: "cap-4", name: "read", content: "ENOENT: no such file or directory",
              isError: true, details: nil),
            .response(
              // iOS markdown parity (2026-09-04): a GFM table rides along so
              // the table renderer is exercised by DashUI; the sentence other
              // tests assert on stays intact as the first paragraph.
              content: "This reply is available offline.\n\n| Region | Status |\n|:---|---:|\n| EU | Ready |\n| US | Pending |",
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

    /// The id of the child `streaming-reconnect` spawns. Shared by the
    /// scripted retired-mirror/`subagent_started` pair, by the row's
    /// accessibility identifier, and by the child conversation this transcript
    /// belongs to — because a worker id IS the child's conversation id.
    static let subagentID = "ui-subagent"

    /// The child's OWN transcript, served by `subagentTranscript(childID:)`
    /// when a row is expanded (design 8.3).
    ///
    /// Two rows, both load-bearing:
    ///
    /// 1. A `origin: "parent"` user row — §8.5's muted "from orchestrator"
    ///    line. It must keep its text (that text is the instruction the child
    ///    is working from) and must offer neither Retry nor Edit & Resend.
    /// 2. An assistant row whose `tool_use` id is `ui-tool` — the SAME id the
    ///    parent's own tool card uses. That collision is deliberate: a
    ///    `tool_use` id is only unique within its conversation, so the nested
    ///    card answering to `chat.subagent.ui-subagent.tool.ui-tool` while the
    ///    parent's answers to `chat.tool.ui-tool` is what proves §8.6's
    ///    namespacing in the running app.
    static func subagentMessages() -> [ConversationMessageDTO] {
      [
        ConversationMessageDTO(
          id: "ui-subagent-brief",
          conversationId: subagentID,
          turnId: "ui-subagent-turn",
          ordinal: 1,
          role: .user,
          status: .completed,
          content: .user(text: "Check whether the launch checklist is complete", images: nil),
          createdAt: now,
          updatedAt: now,
          origin: MessageOrigin.parent.rawValue
        ),
        ConversationMessageDTO(
          id: "ui-subagent-reply",
          conversationId: subagentID,
          turnId: "ui-subagent-turn",
          ordinal: 2,
          role: .assistant,
          status: .completed,
          content: .assistant(events: [
            .toolUseStart(id: "ui-tool", name: "search", input: .object(["query": .string("checklist")])),
            .toolResult(
              id: "ui-tool",
              name: "search",
              content: "Checklist is 4 of 5 done",
              isError: false,
              details: nil
            ),
            .response(
              content: "Four of five items are done.",
              usage: UsageDTO(
                inputTokens: 3,
                outputTokens: 5,
                cacheReadTokens: nil,
                cacheWriteTokens: nil
              )
            ),
          ]),
          createdAt: now.addingTimeInterval(1),
          updatedAt: now.addingTimeInterval(1)
        ),
      ]
    }

    /// The id of the SECOND child `streaming-reconnect` spawns, adjacent to
    /// the first so the two render as one parallel group (§8.2), and parked on
    /// a question so its inline reply composer renders (§8.1).
    static let secondSubagentID = "ui-subagent-2"

    /// What `GET /conversations/{id}/subagents` serves for the shared
    /// conversation — the tasks sheet's WHOLE model (§8.4).
    ///
    /// Both children are `background: true` and both are LIVE, deliberately:
    /// that is the case the sheet exists for. A background child's finish
    /// never reaches the parent's event stream, so the fold can only ever read
    /// it as running, and the list is the only surface that can tell the
    /// truth. It is also served BEFORE any turn is sent, which is honest —
    /// these children outlive the turn that spawned them, so a client opening
    /// the conversation later must still see them.
    static func subagentListEntries() -> [SubagentListEntryDTO] {
      [
        SubagentListEntryDTO(
          id: subagentID,
          name: "scout",
          type: "researcher",
          description: "Check launch readiness",
          status: "running",
          background: true,
          depth: 1,
          startedAt: subagentStartedAt,
          endedAt: nil,
          usage: nil,
          toolCallCount: 3,
          report: nil,
          oneShot: false
        ),
        SubagentListEntryDTO(
          id: secondSubagentID,
          name: nil,
          type: "reviewer",
          description: "Double-check the rollout steps",
          status: "waiting_input",
          background: true,
          depth: 1,
          startedAt: subagentStartedAt.addingTimeInterval(2),
          endedAt: nil,
          usage: nil,
          toolCallCount: 1,
          report: nil,
          oneShot: false
        ),
      ]
    }

    /// Shared by the scripted `subagent_started` and by the REST list, so the
    /// row and the sheet cannot disagree about when a child began.
    static let subagentStartedAt = Date(timeIntervalSince1970: 1_788_480_000)

    static func message(
      id: String,
      turnID: String,
      role: MessageRole,
      status: MessageStatus,
      text: String = "",
      images: [MessageImage]? = nil,
      events: [AgentEvent] = [],
      ordinal: Int,
      origin: String? = nil
    ) -> ConversationMessageDTO {
      ConversationMessageDTO(
        id: id,
        conversationId: sharedConversation.id,
        turnId: turnID,
        ordinal: ordinal,
        role: role,
        status: status,
        content: role == .user ? .user(text: text, images: images) : .assistant(events: events),
        createdAt: now.addingTimeInterval(TimeInterval(ordinal)),
        updatedAt: now.addingTimeInterval(TimeInterval(ordinal)),
        origin: origin
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

    /// A minimal, fully offline `AccountFeatureFactory` that reports as
    /// already signed in — see the call site's comment for why paired
    /// scenarios need one at all despite never showing `GatewayPickerView`
    /// for more than a stray frame.
    static func signedInAccountFactory(
      keychain: any KeychainStoring,
      clock: any AppClock
    ) -> AccountFeatureFactory {
      let config = AccountAuthConfig(
        frontendAPIHost: "ui-test-account.invalid",
        clientID: "ui-test",
        controlPlaneURL: URL(string: "https://ui-test-account.invalid")!,
        redirectURI: "dash://oauth-callback"
      )
      let session = AccountSession(
        preSignedInWithIDToken: "ui-test-id-token",
        expiresAt: Date.distantFuture,
        config: config,
        presenter: UITestWebAuthPresenter(),
        clock: clock
      )
      return AccountFeatureFactory(
        session: session,
        client: ControlPlaneClient(config: config, tokens: session),
        verifier: UITestPairingVerifier(),
        installer: UITestPairingInstaller(keychain: keychain),
        signer: SignerIdentity(keychain: keychain)
      )
    }

    /// Builds the account factory for the sign-in/gateway-picker scenarios
    /// themselves (as opposed to `signedInAccountFactory`'s "already past
    /// this screen" fake for already-paired scenarios).
    ///
    /// `ControlPlaneClient` is a concrete `actor` with no protocol seam, so
    /// rather than let it make a real `URLSession.shared` call against an
    /// `.invalid` host (fine for `signedInAccountFactory`, which only needs
    /// the request to fail fast during a stray pre-`start()` frame, never to
    /// actually resolve), scenario-configurable states inject a stubbed
    /// `URLSession` via `ControlPlaneClient`'s `session:` parameter — see
    /// `UITestControlPlaneURLProtocol`.
    static func accountFactory(
      for scenario: UITestScenario,
      keychain: any KeychainStoring,
      clock: any AppClock
    ) -> AccountFeatureFactory {
      switch scenario {
      case .signedOut:
        return .unavailable

      case .accountPicker:
        UITestControlPlaneScript.shared.setListGateways(
          .init(
            statusCode: 200,
            body: Data(
              """
              {"gateways":[{"gatewayId":"ui-picker-gateway","subdomain":"ui-picker-gateway.relay.dash.example","status":"active","publicKey":"ui-public-key-for-accessibility"}]}
              """.utf8
            )
          )
        )
        UITestControlPlaneScript.shared.setCreatePairing(
          .init(
            statusCode: 200,
            body: Data(
              """
              {"credential":"ui-relay-credential","pairingId":"ui-pairing-1","chatToken":"ui-chat-token","status":"active"}
              """.utf8
            )
          )
        )
        return signedInPickerFactory(keychain: keychain, clock: clock)

      case .accountPickerError:
        UITestControlPlaneScript.shared.setListGateways(.init(statusCode: 500, body: Data()))
        return signedInPickerFactory(keychain: keychain, clock: clock)

      case .accountNotEnrolled:
        UITestControlPlaneScript.shared.setListGateways(
          .init(
            statusCode: 200,
            body: Data(
              """
              {"gateways":[{"gatewayId":"ui-not-enrolled-gateway","subdomain":"ui-not-enrolled-gateway.relay.dash.example","status":"active","publicKey":"ui-public-key-for-accessibility"}]}
              """.utf8
            )
          )
        )
        UITestControlPlaneScript.shared.setCreatePairing(
          .init(
            statusCode: 200,
            body: Data(
              """
              {"credential":"ui-relay-credential","pairingId":"ui-pairing-2","chatToken":null,"status":"active"}
              """.utf8
            )
          )
        )
        return signedInPickerFactory(keychain: keychain, clock: clock)

      case .unpaired, .pairedOnline, .pairedOffline, .streamingReconnect, .remoteBusy,
        .pendingRecovery, .activeRecovery, .agents, .composeNewChat, .settingsForget,
        .approveDevice, .longTranscript:
        // `.approveDevice` never reaches here — `uiTesting`'s ternary routes
        // it to `approveDeviceAccountFactory` first. Listed for exhaustiveness.
        return .unavailable
      }
    }

    /// Signed-in `AccountFeatureFactory` backed by `UITestControlPlaneURLProtocol`
    /// instead of a live network call, and by the SAME verifier/installer
    /// pair `signedInAccountFactory` and pairing scenarios use — so a
    /// successful connect lands on the identical `"ui-gateway"` fixtures
    /// (`sharedConversation`, `research-agent`, …) `pairedOnline` shows.
    private static func signedInPickerFactory(
      keychain: any KeychainStoring,
      clock: any AppClock
    ) -> AccountFeatureFactory {
      let config = AccountAuthConfig(
        frontendAPIHost: "ui-test-account.invalid",
        clientID: "ui-test",
        controlPlaneURL: URL(string: "https://ui-test-control-plane.invalid")!,
        redirectURI: "dash://oauth-callback"
      )
      let session = AccountSession(
        preSignedInWithIDToken: "ui-test-id-token",
        expiresAt: Date.distantFuture,
        config: config,
        presenter: UITestWebAuthPresenter(),
        clock: clock
      )
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [UITestControlPlaneURLProtocol.self]
      let stubbedSession = URLSession(configuration: configuration)
      return AccountFeatureFactory(
        session: session,
        client: ControlPlaneClient(config: config, tokens: session, session: stubbedSession),
        verifier: UITestPairingVerifier(),
        installer: UITestPairingInstaller(keychain: keychain),
        signer: SignerIdentity(keychain: keychain)
      )
    }

    /// Signed-in-AND-paired factory for the `approve-device` scenario
    /// (Task 6): same stubbed-`URLSession` shape `signedInPickerFactory` uses
    /// for the concrete, protocol-seamless `ControlPlaneClient`, but scripted
    /// for the approvals routes (`GET /v1/approvals/:id`,
    /// `POST /v1/approvals/:id/decision`, and `POST /v1/signers` for the
    /// register-then-decide path) instead of gateways/pairings — and paired
    /// with `UITestApprovalQRScanner` instead of a live camera, so the whole
    /// scan-to-approve flow runs with no camera in CI.
    static func approveDeviceAccountFactory(
      keychain: any KeychainStoring,
      clock: any AppClock
    ) -> AccountFeatureFactory {
      let config = AccountAuthConfig(
        frontendAPIHost: "ui-test-account.invalid",
        clientID: "ui-test",
        controlPlaneURL: URL(string: "https://ui-test-control-plane.invalid")!,
        redirectURI: "dash://oauth-callback"
      )
      let session = AccountSession(
        preSignedInWithIDToken: "ui-test-id-token",
        expiresAt: Date.distantFuture,
        config: config,
        presenter: UITestWebAuthPresenter(),
        clock: clock
      )
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [UITestControlPlaneURLProtocol.self]
      let stubbedSession = URLSession(configuration: configuration)
      let expiresAt = Int64((UITestScenarioFixtures.now.timeIntervalSince1970 + 300) * 1000)
      UITestControlPlaneScript.shared.setFetchApproval(
        .init(
          statusCode: 200,
          body: Data(
            """
            {"approvalId":"ui-approval-1","pairingId":"ui-approval-pairing","gatewayId":"ui-approve-gateway","deviceLabel":"Chrome on MacBook","expiresAt":\(expiresAt)}
            """.utf8
          )
        )
      )
      UITestControlPlaneScript.shared.setPostDecision(.init(statusCode: 204, body: Data()))
      UITestControlPlaneScript.shared.setRegisterSigner(
        .init(statusCode: 201, body: Data(#"{"signerId":"ui-signer-1"}"#.utf8))
      )
      return AccountFeatureFactory(
        session: session,
        client: ControlPlaneClient(config: config, tokens: session, session: stubbedSession),
        verifier: UITestPairingVerifier(),
        installer: UITestPairingInstaller(keychain: keychain),
        signer: SignerIdentity(keychain: keychain),
        scanner: UITestApprovalQRScanner(payload: "dash-approve:v1:ui-approval-1")
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
      let recoveryChanges = ConversationRecoveryChangeSignal()
      let recoveryService = UITestConversationRecoveryService(
        store: store,
        recoveryChanges: recoveryChanges
      )
      let keychain = UITestKeychainStore()
      let clock = UITestClock()
      // Compose-first new chat (Task 3, audit #16): a fresh, in-memory
      // last-used-agent store scoped to THIS launch — never the real
      // `LastUsedAgentStore` (which persists to `UserDefaults.standard` and
      // would leak one test's agent selection into the next test on the
      // same simulator).
      let lastUsedAgentStore = UITestLastUsedAgentStore()

      return AppDependencies(
        clock: clock,
        loadProfile: {
          scenario.startsPaired ? UITestScenarioFixtures.profile : nil
        },
        makeSyncEngine: { _ in
          UITestSyncEngine(snapshot: await store.syncSnapshot())
        },
        verifyProfile: { _ in scenario.capabilities },
        // The same answer `/health` gives at launch, so a UI test sees the
        // capability without having to trigger a reconnect first.
        fetchCapabilities: { _ in scenario.capabilities },
        rememberProfile: { _ in },
        deleteProfileSecrets: { profile in
          await keychain.delete(for: profile.id)
        },
        clearProfileData: { _ in
          await store.clear()
        },
        forgetProfileSelection: { _ in },
        makeConversationListFeature: { profile in
          ConversationListFeature(
            gatewayID: profile.gatewayID,
            service: store,
            recoveryService: recoveryService,
            recoveryChanges: recoveryChanges,
            lastUsedAgentStore: lastUsedAgentStore
          )
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
            transport: UITestChatTransport(scenario: scenario),
            clock: clock,
            announcer: UITestAccessibilityAnnouncer(),
            recoveryChanges: recoveryChanges,
            makeID: { source.next() },
            makeDictation: {
              DictationFeature(
                recorder: UITestAudioRecorder(),
                permission: UITestSpeechPermission(),
                transcriber: UITestSpeechTranscriber(seed: UITestLaunchOptions.dictation),
                // Deliberately the SYSTEM clock, not `UITestClock` (which is
                // frozen): the countdown has to actually count down in a
                // capture, and a UI test never runs a recording near the 60 s
                // cap.
                clock: SystemAppClock(),
                session: UITestSpeechSessionControl(),
                interruptions: { AsyncStream { _ in } }
              )
            },
            makeVoiceMode: { id, agentID, conversationID, transport in
              VoiceModeFeature(
                id: id,
                agentID: agentID,
                conversationID: conversationID,
                transport: transport,
                capture: UITestAudioCapture(),
                player: UITestAudioPlayer(),
                haptics: UITestVoiceHaptics(),
                permission: UITestSpeechPermission(),
                session: UITestSpeechSessionControl(),
                // Deliberately never dismissing: `DASH_UI_TEST_VOICE=ended`
                // exists so the ended state can be READ — and photographed —
                // and a cover that took itself down after 1.5 s could be
                // neither.
                dismissDelay: nil
              )
            }
          )
        },
        // Settings > Speech, answered from the contract fixtures
        // (`contracts/mobile/v1/fixtures/speech-{config,models}.json`) so the
        // screen has a provider, two model lists and a voice list without a
        // gateway. Patches are merged the way `mergeSpeechConfig` merges
        // them, so a UI test that changes a picker sees what the gateway
        // would have answered.
        makeSpeechSettingsFeature: { _ in
          SpeechSettingsFeature(
            api: UITestSpeechConfigurator(),
            synthesizer: UITestSpeechSynthesizer(),
            player: UITestAudioPlayer(),
            session: UITestSpeechSessionControl()
          )
        },
        pairingFeatureFactory: PairingFeatureFactory(
          verifier: UITestPairingVerifier(),
          installer: UITestPairingInstaller(keychain: keychain)
        ),
        // Account sign-in (`SignInView`/`GatewayPickerView`) fronts every
        // scenario's unpaired state now that QR/manual pairing entry is
        // retired. `.unpaired` needs an actually-signed-out factory so its UI
        // tests can exercise `SignInView`; every other (already-paired)
        // scenario gets a minimal pre-signed-in fake purely so `RootView`'s
        // brief pre-`start()` render (before `selectedProfile` is set) has
        // somewhere sensible to land instead of a stray `SignInView` flash.
        accountFeatureFactory: scenario == .approveDevice
          ? UITestScenarioFixtures.approveDeviceAccountFactory(
            keychain: keychain,
            clock: clock
          )
          : scenario.startsPaired
            ? UITestScenarioFixtures.signedInAccountFactory(
              keychain: keychain,
              clock: clock
            )
            : UITestScenarioFixtures.accountFactory(
              for: scenario,
              keychain: keychain,
              clock: clock
            )
      )
    }
  }

  /// A microphone that is always granted: a UI test cannot answer the system
  /// permission alert, and the alert is not what these tests are about.
  private struct UITestSpeechPermission: SpeechPermissionRequesting {
    func requestMicrophone() async -> Bool { true }
  }

  /// No `AVAudioSession` in a UI test: the simulator has no input route, and
  /// arming one would make the harness depend on the host Mac's audio.
  private struct UITestSpeechSessionControl: SpeechSessionControlling {
    func activateRecording() throws {}
    func activatePlayback() throws {}
    func deactivate() {}
  }

  /// Produces a moving meter and a fixed clip. Reuses the real
  /// `AudioLevelBroadcaster`, so the fresh-stream-per-recording contract is
  /// the same one `AudioRecorderService` implements.
  private actor UITestAudioRecorder: AudioRecording {
    nonisolated let levels = AudioLevelBroadcaster()
    nonisolated var level: AsyncStream<Float> { levels.stream }
    private var meterTask: Task<Void, Never>?

    func start(maxDuration: Duration) async throws {
      meterTask?.cancel()
      meterTask = Task { [levels] in
        var step = 0
        while Task.isCancelled == false {
          do {
            try await Task.sleep(for: .milliseconds(120))
          } catch {
            return
          }
          // A slow sweep between a murmur and a shout, so a capture catches
          // the bar somewhere visible rather than at silence.
          levels.yield(Float(0.05 + 0.2 * abs(sin(Double(step) / 4))))
          step += 1
        }
      }
    }

    func stop() async throws -> Data {
      endMetering()
      return Data("ui-test-clip".utf8)
    }

    func cancel() async {
      endMetering()
    }

    private func endMetering() {
      meterTask?.cancel()
      meterTask = nil
      levels.finish()
    }
  }

  /// Answers "hello world" — the string `DictationUITests` asserts lands in
  /// the composer — unless the launch option asks for a state that needs the
  /// upload to hang (`uploading`) or fail (`failed`).
  /// A microphone that is live but silent: the stream NEVER finishes, since
  /// a finished stream is voice mode's interruption signal and would end
  /// every seeded session a fraction of a second after it opened.
  private actor UITestAudioCapture: AudioCapturing {
    private var continuation: AsyncStream<Data>.Continuation?

    func start() async throws -> AsyncStream<Data> {
      let pair = AsyncStream<Data>.makeStream()
      continuation = pair.continuation
      return pair.stream
    }

    func stop() async {
      continuation?.finish()
      continuation = nil
    }
  }

  /// A simulator has no taptic engine, and a UI test has no way to observe
  /// one. Silence keeps the console clean.
  private struct UITestVoiceHaptics: VoiceHaptics {
    func impact(_ weight: VoiceHapticWeight) {}
    func error() {}
  }

  private struct UITestSpeechTranscriber: SpeechTranscribing {
    let seed: String?

    func transcribe(_ request: TranscriptionRequestDTO) async throws -> TranscriptionResponseDTO {
      switch seed {
      case "uploading":
        // Long enough to outlive any capture; cancelled with the app.
        try await Task.sleep(for: .seconds(600))
        throw CancellationError()
      case "failed":
        throw GatewayError.speech(
          code: "unavailable",
          message: "speech is not configured on this gateway",
          retryable: false
        )
      default:
        return TranscriptionResponseDTO(text: "hello world", durationSeconds: 1.5)
      }
    }
  }

  /// The gateway's speech-config half. Starts from the bundled fixture and
  /// merges patches per section, exactly as `mergeSpeechConfig` does — a fake
  /// that echoed the request back would let a broken one-key patch pass.
  private actor UITestSpeechConfigurator: SpeechConfiguring {
    private var config = SpeechConfigDTO(
      stt: SpeechSttConfigDTO(
        provider: "openrouter",
        model: "openai/whisper-large-v3",
        language: "en"
      ),
      tts: SpeechTtsConfigDTO(
        provider: "openrouter",
        model: "minimax/speech-2.8-turbo",
        voice: "English_expressive_narrator",
        speed: 1
      ),
      realtime: SpeechRealtimeConfigDTO(provider: nil)
    )

    private let providers: [SpeechProviderStatusDTO] = [
      SpeechProviderStatusDTO(
        id: "openrouter",
        capabilities: SpeechCapabilitiesDTO(transcription: true, speech: true, realtime: false),
        available: true
      ),
      SpeechProviderStatusDTO(
        id: "realtime",
        capabilities: SpeechCapabilitiesDTO(transcription: false, speech: false, realtime: true),
        available: false,
        reason: .noProviderOffersRealtime
      ),
    ]

    func speechConfig() async throws -> SpeechConfigResponseDTO {
      SpeechConfigResponseDTO(config: config, providers: providers)
    }

    func patchSpeechConfig(_ patch: SpeechConfigPatchDTO) async throws -> SpeechConfigResponseDTO {
      config = SpeechConfigDTO(
        stt: SpeechSttConfigDTO(
          provider: patch.stt?.provider ?? config.stt.provider,
          model: patch.stt?.model ?? config.stt.model,
          // An omitted key leaves the language alone; an explicit null
          // clears it — `mergeSpeechConfig`'s rule, so the fake cannot pass a
          // patch the gateway would treat differently.
          language: patch.stt?.language.map(\.value) ?? config.stt.language
        ),
        tts: SpeechTtsConfigDTO(
          provider: patch.tts?.provider ?? config.tts.provider,
          model: patch.tts?.model ?? config.tts.model,
          voice: patch.tts?.voice ?? config.tts.voice,
          speed: patch.tts?.speed ?? config.tts.speed
        ),
        realtime: patch.realtime ?? config.realtime
      )
      return SpeechConfigResponseDTO(config: config, providers: providers)
    }

    func speechModels(kind: SpeechModelKind) async throws -> [SpeechModelDTO] {
      switch kind {
      case .transcription:
        return [
          SpeechModelDTO(
            id: "openai/whisper-large-v3",
            name: "Whisper Large v3",
            kind: .transcription,
            voices: nil
          )
        ]
      case .speech:
        return [
          SpeechModelDTO(
            id: "minimax/speech-2.8-turbo",
            name: "MiniMax: Speech 2.8 Turbo",
            kind: .speech,
            voices: ["English_expressive_narrator", "English_radiant_girl"]
          )
        ]
      }
    }
  }

  /// Hands back a few bytes so "Preview voice" reaches the player. The bytes
  /// are never decoded: `UITestAudioPlayer` stands in for playback.
  private struct UITestSpeechSynthesizer: SpeechSynthesizing {
    func synthesize(text: String) async throws -> Data {
      Data([0x49, 0x44, 0x33])
    }
  }

  /// A player with no audio route — the simulator's route is the host Mac's.
  /// `playMP3` takes about as long as a short sample would, so the preview
  /// button's progress state is visible in a capture.
  private actor UITestAudioPlayer: AudioPlaying {
    private var playing = false
    // Fix round 2 (item 4): `AudioPlaying` dropped its default no-op
    // `enqueuePCM`/`flush` — this fake records both so a UI-test scenario
    // driving voice mode can be extended later without silently no-op-ing.
    private(set) var enqueued: [(Data, Double)] = []
    private(set) var flushCount = 0
    private(set) var drainWaits = 0

    var isPlaying: Bool { playing }

    func playMP3(_ data: Data) async throws {
      playing = true
      defer { playing = false }
      try? await Task.sleep(for: .seconds(2))
    }

    func stop() async {
      playing = false
    }

    func enqueuePCM(_ data: Data, sampleRate: Double) async {
      enqueued.append((data, sampleRate))
    }

    func awaitDrain() async {
      drainWaits += 1
    }

    func flush() async {
      flushCount += 1
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

  /// A scripted `QRScanning` fake for the `approve-device` scenario: reports
  /// itself already camera-authorized and hands back `payload` on the first
  /// (and every) `scan()` — no `AVCaptureSession`, so `ApproveDeviceView`'s
  /// scan-to-approve flow runs deterministically with no camera in CI.
  private actor UITestApprovalQRScanner: QRScanning {
    nonisolated let previewSource: QRScannerPreviewSource? = nil
    private let payload: String

    init(payload: String) {
      self.payload = payload
    }

    func authorizationStatus() -> AVAuthorizationStatus { .authorized }
    func requestAccess() async -> Bool { true }
    func scan() async throws -> String { payload }
    func stop() {}
  }

  /// Never actually invoked by current scenarios (nothing signs out and
  /// back in mid-test), but backs `signedInAccountFactory`'s pre-signed-in
  /// `AccountSession` the same way `UnavailableWebAuthPresenter` backs
  /// `AccountFeatureFactory.unavailable` — a harmless placeholder that fails
  /// closed if it's ever reached.
  private struct UITestWebAuthPresenter: WebAuthPresenting {
    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
      throw AccountSessionError.exchangeFailed
    }
  }

  /// Lock-guarded canned responses `UITestControlPlaneURLProtocol` serves,
  /// mirroring `UITestIdentifierSource`'s `NSLock`-based `@unchecked Sendable`
  /// shape below. The app process is scenario-scoped (one scenario per
  /// launch), so a single shared script — set once before `GatewayPickerView`
  /// issues its first request — is enough.
  private final class UITestControlPlaneScript: @unchecked Sendable {
    struct Response {
      let statusCode: Int
      let body: Data
    }

    static let shared = UITestControlPlaneScript()

    private let lock = NSLock()
    private var listGateways = Response(statusCode: 200, body: Data(#"{"gateways":[]}"#.utf8))
    private var createPairing = Response(
      statusCode: 200,
      body: Data(
        #"{"credential":"ui-relay-credential","pairingId":"ui-pairing","chatToken":"ui-chat-token","status":"active"}"#
          .utf8
      )
    )
    /// `GET /v1/approvals/:id` (Task 6's `approve-device` scenario).
    private var fetchApproval = Response(statusCode: 404, body: Data(#"{"error":"not found"}"#.utf8))
    /// `POST /v1/approvals/:id/decision`.
    private var postDecision = Response(statusCode: 204, body: Data())
    /// `POST /v1/signers` (the register-then-decide path).
    private var registerSigner = Response(
      statusCode: 201,
      body: Data(#"{"signerId":"ui-signer"}"#.utf8)
    )

    func setListGateways(_ response: Response) {
      lock.withLock { listGateways = response }
    }

    func setCreatePairing(_ response: Response) {
      lock.withLock { createPairing = response }
    }

    func setFetchApproval(_ response: Response) {
      lock.withLock { fetchApproval = response }
    }

    func setPostDecision(_ response: Response) {
      lock.withLock { postDecision = response }
    }

    func setRegisterSigner(_ response: Response) {
      lock.withLock { registerSigner = response }
    }

    func currentListGateways() -> Response {
      lock.withLock { listGateways }
    }

    func currentCreatePairing() -> Response {
      lock.withLock { createPairing }
    }

    func currentFetchApproval() -> Response {
      lock.withLock { fetchApproval }
    }

    func currentPostDecision() -> Response {
      lock.withLock { postDecision }
    }

    func currentRegisterSigner() -> Response {
      lock.withLock { registerSigner }
    }
  }

  /// `URLProtocol` stub letting UI-test scenarios drive the concrete
  /// `ControlPlaneClient` (an `actor` with no protocol seam) through canned
  /// HTTP responses. Installed on a private `URLSessionConfiguration` handed
  /// to `ControlPlaneClient`'s `session:` initializer parameter — the one
  /// seam that type already exposes — instead of letting requests reach a
  /// live `URLSession`.
  private final class UITestControlPlaneURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
      request.url?.host == "ui-test-control-plane.invalid"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
      guard let url = request.url else {
        client?.urlProtocol(self, didFailWithError: URLError(.badURL))
        return
      }
      let response: UITestControlPlaneScript.Response
      if request.httpMethod == "GET", url.path.hasSuffix("/gateways") {
        response = UITestControlPlaneScript.shared.currentListGateways()
      } else if request.httpMethod == "POST", url.path.contains("/pairings/") {
        response = UITestControlPlaneScript.shared.currentCreatePairing()
      } else if request.httpMethod == "GET", url.path.contains("/approvals/") {
        response = UITestControlPlaneScript.shared.currentFetchApproval()
      } else if request.httpMethod == "POST", url.path.hasSuffix("/decision") {
        response = UITestControlPlaneScript.shared.currentPostDecision()
      } else if request.httpMethod == "POST", url.path.hasSuffix("/signers") {
        response = UITestControlPlaneScript.shared.currentRegisterSigner()
      } else {
        client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
        return
      }
      guard
        let httpResponse = HTTPURLResponse(
          url: url,
          statusCode: response.statusCode,
          httpVersion: "HTTP/1.1",
          headerFields: ["Content-Type": "application/json"]
        )
      else {
        client?.urlProtocol(self, didFailWithError: URLError(.cannotParseResponse))
        return
      }
      client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: response.body)
      client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
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

  /// Compose-first new chat (Task 3, audit #16): per-launch, in-memory
  /// `LastUsedAgentStoring` fake — see the `AppDependencies.uiTesting`
  /// call-site comment for why this can't be the real UserDefaults-backed
  /// `LastUsedAgentStore`.
  actor UITestLastUsedAgentStore: LastUsedAgentStoring {
    private var values: [String: String] = [:]

    func agentID(gatewayID: String) -> String? {
      values[gatewayID]
    }

    func setAgentID(_ agentID: String, gatewayID: String) {
      values[gatewayID] = agentID
    }

    func clear(gatewayID: String) {
      values[gatewayID] = nil
    }
  }

  actor UITestScenarioStore: ConversationListServicing, AgentsServicing, ChatFeaturePersisting,
    ChatFeatureSynchronizing
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
    private var memoryValues: [String: [MemoryInfoDTO]] = UITestScenarioFixtures.memories
    private var skillValues: [String: [SkillDTO]] = UITestScenarioFixtures.skills
    private var didFailSleepingAgentEnable = false
    /// Mutable, because `stopSubagent` really terminalizes a row here the way
    /// the route does — that is what lets a UI test watch the badge count down.
    private var subagentEntries: [SubagentListEntryDTO] = []

    init(scenario: UITestScenario, dataIdentifier: String) {
      self.dataIdentifier = dataIdentifier
      self.scenario = scenario
      agentValues = UITestScenarioFixtures.agents
      // Compose-first new chat (Task 3, audit #16): `.composeNewChat` starts
      // with no seeded conversation at all, unlike every other paired
      // scenario — see the case's doc comment in `UITestScenario`.
      if scenario == .composeNewChat {
        conversationValues = []
        messages = [:]
      } else {
        let conversation = UITestScenarioFixtures.conversation(for: scenario)
        conversationValues = [conversation]
        messages = [conversation.id: UITestScenarioFixtures.cachedMessages(for: scenario)]
        cursors[conversation.id] = conversation.lastSeq
      }
      if scenario == .pendingRecovery || scenario == .activeRecovery {
        pendingSends[conversationValues[0].id] = UITestScenarioFixtures.recoveredPendingSend
        drafts[conversationValues[0].id] = UITestScenarioFixtures.recoveredNewerDraft
      }
      if scenario == .streamingReconnect {
        subagentEntries = UITestScenarioFixtures.subagentListEntries()
      }
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
      memoryValues.removeAll()
      skillValues.removeAll()
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

    func conversation(id: String) throws -> ConversationSummaryDTO {
      guard let value = conversationValues.first(where: { $0.id == id }) else {
        throw GatewayError.notFound
      }
      return value
    }

    func create(_ request: CreateConversationRequest) -> ConversationSummaryDTO {
      // Review fix (I1/I2 fixture mismatch, Task 3 review): dedup only
      // against a LIVE (non-deleted) existing conversation for this agent.
      // A real gateway's create endpoint would never hand back an
      // already-deleted conversation for a repeat create — it only
      // idempotently returns a conversation that's still actually there.
      // Compose-first's own cleanup (`ConversationListFeature
      // .discardIfUnusedComposeCreation`, review fix I1) makes this
      // reachable now: compose, switch agents (creating a second
      // conversation), then leave it unsent — the first create's result
      // gets deleted, and composing with that SAME agent again must create
      // a genuinely fresh conversation, not resurrect the tombstone.
      if let existing = conversationValues.first(where: {
        $0.agentId == request.agentId && $0.status != .deleted
      }) {
        return existing
      }
      let agent = agentValues.first { $0.id == request.agentId }
      let value = ConversationSummaryDTO(
        id: "conversation-\(request.agentId)",
        agentId: request.agentId,
        agentName: agent?.name ?? "Agent",
        // Final-review fix C2 (fixture-fidelity follow-up): the real gateway
        // ignores nothing here — `create(agentID:)` (ConversationListFeature.swift)
        // always sends `title: nil` for the compose-first flow, so the
        // REAL default is always `ChatState.defaultConversationTitle`
        // ("New Conversation"), never a synthesized "Chat with <agent>".
        // This mock previously diverged from that, which meant every
        // compose-created conversation in UI tests looked ALREADY renamed
        // to `ChatState.hasComposeActivity`'s title check — silently
        // defeating `discardIfUnusedComposeCreation`'s cleanup for every UI
        // test (caught by `testComposeThenBackWithoutSendingLeavesNoPermanentRow`).
        // `request.title` is still honored when a caller explicitly
        // supplies one (none currently do, but the real endpoint accepts
        // it) so this stays a faithful stand-in either way.
        title: request.title ?? ChatState.defaultConversationTitle,
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
      // The deterministic `"conversation-\(agentId)"` id means a fresh
      // create for an agent whose PRIOR conversation was deleted collides
      // with that stale (tombstoned) entry's id — replace it in place
      // rather than appending a duplicate id, which would otherwise shadow
      // the new live entry behind the old tombstone in every `first(where:)`
      // lookup keyed by id.
      if let staleIndex = conversationValues.firstIndex(where: { $0.id == value.id }) {
        conversationValues[staleIndex] = value
      } else {
        conversationValues.append(value)
      }
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

    func replace(_ summary: ConversationSummaryDTO) -> ConversationSummaryDTO {
      if let index = conversationValues.firstIndex(where: { $0.id == summary.id }) {
        conversationValues[index] = summary
      } else {
        conversationValues.append(summary)
      }
      return summary
    }

    func remove(
      id: String,
      expectedCanonical: ConversationSummaryDTO
    ) -> ConversationRemovalOutcome {
      if let current = conversationValues.first(where: { $0.id == id }),
        current != expectedCanonical
      {
        return .retained(current)
      }
      conversationValues.removeAll { $0.id == id }
      messages[id] = nil
      return .removed
    }

    func retainedCreateRequestID(agentID: String, suggested: String) -> String {
      if let retained = retainedRequests[agentID] { return retained }
      retainedRequests[agentID] = suggested
      return suggested
    }

    func clearRetainedCreateRequestID(agentID: String) {
      retainedRequests[agentID] = nil
    }

    func recoverablePendingSends() -> [RecoverablePendingSend] {
      pendingSends.compactMap { conversationID, pendingSend in
        let conversation = conversationValues.first { $0.id == conversationID }
        let conversationAvailable = isConversationAvailable(conversationID)
        guard conversationAvailable == false || drafts[conversationID] != nil else { return nil }
        return RecoverablePendingSend(
          gatewayID: "ui-gateway",
          conversationID: conversationID,
          conversationTitle: conversation?.title,
          agentName: conversation?.agentName,
          pendingSend: pendingSend,
          coexistingDraft: drafts[conversationID],
          conversationAvailable: conversationAvailable
        )
      }
      .sorted { $0.pendingSend.createdAt > $1.pendingSend.createdAt }
    }

    func discard(_ recovery: RecoverablePendingSend) -> Bool {
      guard recovery.gatewayID == "ui-gateway",
        pendingSends[recovery.conversationID]?.turnID == recovery.pendingSend.turnID
      else { return false }
      let conversationAvailable = isConversationAvailable(recovery.conversationID)
      guard recovery.conversationAvailable == conversationAvailable else { return false }
      pendingSends[recovery.conversationID] = nil
      if conversationAvailable == false {
        drafts[recovery.conversationID] = nil
      }
      return true
    }

    private func isConversationAvailable(_ conversationID: String) -> Bool {
      conversationValues.contains {
        $0.id == conversationID && $0.status != .deleted
      }
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
      memoryValues[id] = nil
    }

    func memories(for agentID: String) -> [MemoryInfoDTO] {
      memoryValues[agentID] ?? []
    }

    func skills(for agentID: String) -> [SkillDTO] {
      skillValues[agentID] ?? []
    }

    func deleteMemory(agentID: String, name: String) throws {
      guard var values = memoryValues[agentID],
        values.contains(where: { $0.name == name })
      else {
        throw GatewayError.notFound
      }
      values.removeAll { $0.name == name }
      memoryValues[agentID] = values
    }

    func startConversation(agentID: String) throws -> ConversationSummaryDTO {
      // See `create(_:)`'s matching comment: dedup only against a LIVE
      // conversation, same as a real gateway would.
      if let existing = conversationValues.first(where: {
        $0.agentId == agentID && $0.status != .deleted
      }) {
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

    func pendingSend(gatewayID: String, conversationID: String) -> PendingSendLoadResult {
      guard let pending = pendingSends[conversationID] else { return .none }
      let conversation = conversationValues.first { $0.id == conversationID }
      let conversationAvailable = isConversationAvailable(conversationID)
      guard conversationAvailable, drafts[conversationID] == nil else {
        return .recoveryRequired(
          RecoverablePendingSend(
            gatewayID: gatewayID,
            conversationID: conversationID,
            conversationTitle: conversation?.title,
            agentName: conversation?.agentName,
            pendingSend: pending,
            coexistingDraft: drafts[conversationID],
            conversationAvailable: conversationAvailable
          )
        )
      }
      return .resumable(pending)
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
    ) -> PendingSendStageResult {
      _ = gatewayID
      guard pendingSends[conversationID] == nil else { return .pendingAlreadyExists }
      pendingSends[conversationID] = pending
      drafts[conversationID] = nil
      return .staged
    }

    func clearPendingSend(
      gatewayID: String,
      conversationID: String,
      turnID: String
    ) -> PendingSendClearResult {
      _ = gatewayID
      guard isConversationAvailable(conversationID) else { return .conversationUnavailable }
      guard pendingSends[conversationID]?.turnID == turnID else { return .cleared }
      pendingSends[conversationID] = nil
      return .cleared
    }

    func pendingSendAvailability(
      gatewayID: String,
      conversationID: String,
      turnID: String
    ) -> PendingSendAvailability {
      _ = gatewayID
      guard pendingSends[conversationID]?.turnID == turnID else { return .pendingMissing }
      guard
        conversationValues.contains(where: {
          $0.id == conversationID && $0.status != .deleted
        })
      else { return .conversationUnavailable }
      return .active
    }

    func restorePendingSendAsDraft(
      gatewayID: String,
      conversationID: String,
      turnID: String
    ) -> PendingSendRestoreResult {
      _ = gatewayID
      guard isConversationAvailable(conversationID) else { return .conversationUnavailable }
      guard let pending = pendingSends[conversationID], pending.turnID == turnID else {
        return .restored(nil)
      }
      if let existingDraft = drafts[conversationID] {
        return .draftConflict(existingDraft)
      }
      let draft = ConversationDraft(
        text: pending.draft,
        attachments: pending.attachments,
        updatedAt: pending.createdAt
      )
      pendingSends[conversationID] = nil
      drafts[conversationID] = draft
      return .restored(draft)
    }

    func advanceCursor(gatewayID: String, conversationID: String, to seq: Int) {
      _ = gatewayID
      cursors[conversationID] = max(cursors[conversationID] ?? 0, seq)
    }

    func refresh(conversationID: String, before: String?) throws -> ChatCanonicalSnapshot {
      guard let summary = conversationValues.first(where: { $0.id == conversationID }) else {
        throw GatewayError.notFound
      }
      // `.longTranscript` is the only scenario with a second page: the
      // canonical refresh (`before == nil`) advertises it, and asking for it
      // returns the 10 oldest messages with nothing behind them.
      if scenario == .longTranscript, conversationID == UITestScenarioFixtures.sharedConversation.id {
        if before == UITestScenarioFixtures.longTranscriptOlderCursor {
          return ChatCanonicalSnapshot(
            summary: summary,
            messages: UITestScenarioFixtures.longTranscriptOlderMessages,
            nextCursor: nil,
            throughSeq: summary.lastSeq
          )
        }
        return ChatCanonicalSnapshot(
          summary: summary,
          messages: messages[conversationID] ?? [],
          nextCursor: UITestScenarioFixtures.longTranscriptOlderCursor,
          throughSeq: summary.lastSeq
        )
      }
      _ = before
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

    func subagentTranscript(childID: String) throws -> SubagentTranscriptSnapshot {
      guard subagentEntries.contains(where: { $0.id == childID }) else {
        throw GatewayError.notFound
      }
      return SubagentTranscriptSnapshot(
        messages: childID == UITestScenarioFixtures.subagentID
          ? UITestScenarioFixtures.subagentMessages()
          : [],
        // Not one-shot, so the body composer is offered. The waiting-input
        // reply is enabled either way — a one-shot child parked on
        // `ask_orchestrator` can still be answered.
        oneShot: false
      )
    }

    func subagents(conversationID: String) -> [SubagentListEntryDTO] {
      guard conversationID == UITestScenarioFixtures.sharedConversation.id else { return [] }
      return subagentEntries
    }

    func stopSubagent(id: String) throws -> String {
      guard let index = subagentEntries.firstIndex(where: { $0.id == id }) else {
        throw GatewayError.notFound
      }
      let entry = subagentEntries[index]
      // The route 409s a child that is ALREADY terminal rather than silently
      // succeeding, so a client that raced the child's own finish learns which
      // of the two won. Reproduced here verbatim
      // (`apps/gateway/src/subagent-management.ts:424-431`).
      guard SubagentCardStatus(wire: entry.status).isTerminal == false else {
        throw GatewayError.validation("Sub-agent \(id) is already \(entry.status)")
      }
      subagentEntries[index] = SubagentListEntryDTO(
        id: entry.id,
        name: entry.name,
        type: entry.type,
        description: entry.description,
        status: "cancelled",
        background: entry.background,
        depth: entry.depth,
        startedAt: entry.startedAt,
        endedAt: UITestScenarioFixtures.now,
        usage: entry.usage,
        toolCallCount: entry.toolCallCount,
        report: entry.report,
        oneShot: entry.oneShot
      )
      return "cancelled"
    }

    func resumeSubagent(id: String, message: String, requestID: String) throws {
      guard let entry = subagentEntries.first(where: { $0.id == id }) else {
        throw GatewayError.notFound
      }
      // A TERMINAL child is refused, reproducing `coordinator.resumeChild`'s
      // own text (`packages/swarm/src/coordinator.ts:717`): a finished child
      // has no live handle, so a resume goes down the rebuild path and a grant
      // that cannot be rebuilt is refused with a 409. This is reachable from
      // the tasks sheet by design — `SubagentTaskRow.canResume` offers Resume
      // on every non-one-shot child including one that has finished — and it
      // is the refusal that had no render site at all before D6 fix round 1.
      guard SubagentCardStatus(wire: entry.status).isTerminal == false else {
        throw GatewayError.validation(
          "Agent \"\(entry.name ?? entry.id)\" cannot be resumed: its grant cannot be rebuilt."
        )
      }
      // Otherwise the scripted gateway accepts it; the assertion that matters
      // is in the app, where the optimistic row must render as an orchestrator
      // row carrying the user's own text.
      _ = message
      _ = requestID
    }

    func shutdown() {}
  }

  private actor UITestConversationRecoveryService: ConversationRecoveryServicing {
    private let store: UITestScenarioStore
    private let recoveryChanges: ConversationRecoveryChangeSignal

    init(
      store: UITestScenarioStore,
      recoveryChanges: ConversationRecoveryChangeSignal
    ) {
      self.store = store
      self.recoveryChanges = recoveryChanges
    }

    func recoverablePendingSends() async -> [RecoverablePendingSend] {
      await store.recoverablePendingSends()
    }

    func discard(_ recovery: RecoverablePendingSend) async -> Bool {
      let discarded = await store.discard(recovery)
      if discarded {
        await recoveryChanges.send(gatewayID: recovery.gatewayID)
      }
      return discarded
    }
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
    private let scenario: UITestScenario
    private var stream: AsyncThrowingStream<ChatConnectionEvent, Error>
    private var continuation: AsyncThrowingStream<ChatConnectionEvent, Error>.Continuation
    private var scriptTask: Task<Void, Never>?
    private var activeTurnID: String?
    private var nextSequence = 1
    private var isTerminal = false

    init(scenario: UITestScenario) {
      self.scenario = scenario
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

    /// The UI-test harness has no gateway to subscribe against; a
    /// server-initiated turn is scripted directly onto `continuation`.
    func subscribe(agentID: String, conversationID: String) {}

    func unsubscribe(agentID: String, conversationID: String) {}

    // The UI-test harness has no voice session to drive; these are no-ops.
    func voiceStart(id: String, agentID: String, conversationID: String) {
      _ = id
      _ = agentID
      _ = conversationID
    }

    func voiceAudio(id: String, seq: Int, pcm: Data) {
      _ = id
      _ = seq
      _ = pcm
    }

    func voiceMute(id: String, muted: Bool) {
      _ = id
      _ = muted
    }

    func voicePlayed(id: String, seq: Int) {
      _ = id
      _ = seq
    }

    func voiceStop(id: String) {
      _ = id
    }

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
      if scenario == .longTranscript {
        await runLongStreamScript(turnID: turnID, conversationID: conversationID)
        return
      }
      guard await pause(.milliseconds(150)) else { return }
      yield(
        .accepted(
          id: turnID,
          conversationId: conversationID,
          userMessageId: "user-ui-turn",
          assistantMessageId: "assistant-ui-turn",
          revision: 2,
          seq: takeSequence(),
          origin: nil,
          kind: nil,
          requestId: nil
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
      // A TodoWrite call, so the task-card checklist has UI-test coverage
      // (task cards 2026-09-05). Additive: the `ui-tool` search card above
      // is untouched, so assertions on it are unaffected.
      yieldEvent(
        turnID: turnID,
        conversationID: conversationID,
        .toolUseStart(
          id: "ui-todo",
          name: "todowrite",
          input: .object([
            "todos": .array([
              .object(["content": .string("Draft the plan"), "status": .string("completed")]),
              .object(["content": .string("Check launch readiness"), "status": .string("in_progress")]),
              .object(["content": .string("Ship it"), "status": .string("pending")]),
            ])
          ])
        )
      )
      yieldEvent(
        turnID: turnID,
        conversationID: conversationID,
        .toolResult(
          id: "ui-todo",
          name: "todowrite",
          content: "Updated task list",
          isError: false,
          details: nil
        )
      )
      yieldEvent(
        turnID: turnID,
        conversationID: conversationID,
        // A PERSISTED PRE-D8 shape: the retired `worker_spawned` mirror ahead
        // of the `subagent_started` that is now the only anchor. Nothing emits
        // this pair any more; the scenario keeps it because
        // `ConversationUITests` asserting exactly ONE
        // `chat.subagent.ui-subagent` element is the D8 drop policy proven in
        // the running app, not just in the reducer.
        .workerSpawned(
          workerId: "ui-subagent",
          runId: "ui-run",
          role: "researcher",
          brief: "Check launch readiness",
          model: "openai/gpt-5"
        )
      )
      yieldEvent(
        turnID: turnID,
        conversationID: conversationID,
        .subagentStarted(
          subagentId: "ui-subagent",
          name: "scout",
          subagentType: "researcher",
          description: "Check launch readiness",
          prompt: "Check whether the launch checklist is complete",
          // `background: true` is load-bearing for the UI assertions, not
          // decoration. This scenario's child never reports a terminal event
          // and the parent turn DOES end, so a foreground child would be
          // end-of-stream terminalized to `cancelled` mid-test — the row's
          // label would depend on whether the assertion won the race against
          // the scripted `done`. A background child is exempt (it is spawned
          // to outlive its turn), so the row reads "Running" in both phases,
          // and the exemption is pinned in the running app rather than only in
          // the reducer.
          model: "openai/gpt-5",
          background: true,
          depth: 1,
          startedAt: Date(timeIntervalSince1970: 1_788_480_000),
          isolation: nil,
          parentTurnId: turnID
        )
      )
      yieldEvent(
        turnID: turnID,
        conversationID: conversationID,
        .subagentProgress(
          subagentId: "ui-subagent",
          status: .running,
          toolCallCount: 3,
          elapsedMs: 7200,
          detail: "Reviewing the checklist",
          question: nil
        )
      )
      yieldEvent(
        turnID: turnID,
        conversationID: conversationID,
        // A SECOND child spawned inside the same message with nothing but
        // sub-agent chrome in between, which is exactly §8.2's adjacency rule
        // (`SubagentDraft.chromeRank`) — so the two render inside one parallel
        // group with a summary line and a dot strip. Nothing had ever rendered
        // that chrome in a UI test before; every existing sub-agent test ran
        // against a cluster of ONE, where the group header does not exist.
        //
        // `background: true` for the same reason the first child is: this
        // scenario's children never report a terminal event and the parent turn
        // does end, so a foreground child would be end-of-stream terminalized
        // to `cancelled` mid-test — and D1's rule that a question never
        // survives onto a terminal row would then clear the reply below.
        .subagentStarted(
          subagentId: "ui-subagent-2",
          name: nil,
          subagentType: "reviewer",
          description: "Double-check the rollout steps",
          prompt: "Double-check the rollout steps",
          model: "openai/gpt-5",
          background: true,
          depth: 1,
          startedAt: Date(timeIntervalSince1970: 1_788_480_002),
          isolation: nil,
          parentTurnId: turnID
        )
      )
      yieldEvent(
        turnID: turnID,
        conversationID: conversationID,
        // Parks the second child on a question, so §8.1's inline reply
        // composer RENDERS. D5 closed with that composer never having been
        // rendered by any test — only what it sends was pinned, at feature
        // level — and this is the cheapest thing that closes it.
        .subagentProgress(
          subagentId: "ui-subagent-2",
          status: .waitingInput,
          toolCallCount: 1,
          elapsedMs: 3000,
          detail: nil,
          question: "Should the rollback step come first?"
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

    /// `.longTranscript`'s send: the same ack shape as the default script,
    /// then `longTranscriptStreamedReply` in 90 word-group deltas ~120ms
    /// apart (≈11s), so a UI test has time to scroll while the reply streams.
    private func runLongStreamScript(turnID: String, conversationID: String) async {
      guard await pause(.milliseconds(150)) else { return }
      yield(
        .accepted(
          id: turnID,
          conversationId: conversationID,
          userMessageId: "user-ui-turn",
          assistantMessageId: "assistant-ui-turn",
          revision: 2,
          seq: takeSequence(),
          origin: nil,
          kind: nil,
          requestId: nil
        )
      )
      let reply = UITestScenarioFixtures.longTranscriptStreamedReply
      let chunks = reply.components(separatedBy: "Streamed").dropFirst().map { "Streamed" + $0 }
      for chunk in chunks {
        guard await pause(.milliseconds(120)) else { return }
        yieldEvent(turnID: turnID, conversationID: conversationID, .textDelta(text: chunk))
      }
      guard await pause(.milliseconds(120)) else { return }
      yieldEvent(
        turnID: turnID,
        conversationID: conversationID,
        .response(
          content: reply,
          usage: UsageDTO(inputTokens: 12, outputTokens: 180, cacheReadTokens: nil, cacheWriteTokens: nil)
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
