# Android–iOS Feature Parity Ledger

- iOS baseline: `905db902db5646f456ce9fded5cf1b289e81a7ac`
- Baseline date: 2026-09-06
- Contract: `contracts/mobile/v1/`
- Status values: `Foundation in progress`, `Foundation verified`, `Chat phase`, `Surfaces phase`,
  `Release phase`, `Not applicable on Android`

| ID | iOS behavior | Android entry point | Automated evidence | Manual evidence | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| AUTH-01 | PKCE browser sign-in; cancel is harmless | `AccountSession.signIn` | `AccountSessionTest` | OAuth callback/custom-tab case | Foundation | Foundation in progress |
| AUTH-02 | Account bearer expires in memory and is not restored | `AccountSession.requireIdToken` | `AccountSessionTest` | terminate/relaunch sign-in case | Foundation | Foundation in progress |
| AUTH-03 | Gateway list loading/empty/error/retry | `AppCoordinator.listGateways` | `DefaultAppCoordinatorTest` | gateway picker matrix | Surfaces | Surfaces phase |
| AUTH-04 | Mint, verify identity/capabilities, and install relay credential | `GatewayEnrollmentService.install` | `GatewayEnrollmentServiceTest` | cellular relay connect | Foundation | Foundation in progress |
| AUTH-05 | Switching gateways tears down the previous runtime first | `DefaultAppCoordinator.switchGateway` | `DefaultAppCoordinatorTest` | two-gateway switch | Foundation | Foundation in progress |
| AUTH-06 | Sign out clears account memory and signer identity, not installed gateways | `DefaultAppCoordinator.signOut` | `DefaultAppCoordinatorTest` | sign-out/relaunch | Foundation | Foundation in progress |
| AUTH-07 | Disconnect & Forget revokes when possible and removes secrets/cache/selection | `DefaultAppCoordinator.disconnectAndForget` | `DefaultAppCoordinatorTest` | revoke and forget | Foundation | Foundation in progress |
| SEC-01 | Device signer registration uses raw Ed25519 | `SignerIdentity` | `TinkEd25519VectorTest` | signer registration | Foundation | Foundation in progress |
| SEC-02 | Approval QR scan names requester/gateway; approve/deny | `feature:approval` | `ApproveDeviceViewModelTest` | approval QR matrix | Surfaces | Surfaces phase |
| SEC-03 | Invalid, expired, decided, forbidden, and tampered approvals recover honestly | `feature:approval` | `ApproveDeviceViewModelTest` | tamper/expiry cases | Surfaces | Surfaces phase |
| SEC-04 | Keystore loss, uninstall/reinstall, and revocation require repair | `EncryptedSecretStore` | `AndroidKeystoreSecretStoreTest` | uninstall/reinstall/revoke | Foundation | Foundation in progress |
| CONV-01 | Cached conversations render before refresh | `feature:conversations` | `ConversationListViewModelTest` | offline cold launch | Chat | Chat phase |
| CONV-02 | Refresh/paginate canonical conversation summaries | `GatewaySyncEngine` | `GatewaySyncEngineTest` | long account list | Foundation | Foundation in progress |
| CONV-03 | Compose-first draft creates exactly one conversation on first send | `feature:conversations` | `ComposeFirstConversationTest` | new-chat process death | Chat | Chat phase |
| CONV-04 | Rename uses revision protection and conflict copy | `feature:conversations` | `ConversationMutationTest` | two-client conflict | Chat | Chat phase |
| CONV-05 | Delete confirms, tombstones, and reconciles failure/unknown outcome | `feature:conversations` | `ConversationMutationTest` | delete conflict | Chat | Chat phase |
| CONV-06 | Other-client changes/deletes reconcile by SSE refetch | `GatewaySyncEngine` | `GatewaySyncEngineTest` | iOS/Mission Control sync | Foundation | Foundation in progress |
| CHAT-01 | Send and resumable stream preserve one canonical turn | `feature:chat` + `ChatConnection` | `ChatTurnCoordinatorTest` | cross-client transcript | Chat | Chat phase |
| CHAT-02 | Server-initiated active turns subscribe and resume | `feature:chat` + `ChatConnection` | `ChatTurnCoordinatorTest` | Mission Control-started turn | Chat | Chat phase |
| CHAT-03 | Cancel/retry/edit-and-resend expose canonical limitations | `feature:chat` | `ChatTurnCoordinatorTest` | cancel/retry matrix | Chat | Chat phase |
| CHAT-04 | Active-turn conflict is explicit | `feature:chat` | `ChatTurnCoordinatorTest` | simultaneous send | Chat | Chat phase |
| CHAT-05 | Question answer prevents duplicate taps and reconciles ambiguous loss | `feature:chat` | `QuestionCoordinatorTest` | cross-client question | Chat | Chat phase |
| CHAT-06 | Agent/model selection uses live gateway catalogs | `feature:conversations` | `ConversationComposerTest` | picker empty/error | Chat | Chat phase |
| CHAT-07 | Four images and iOS MIME/per-file/aggregate limits | `feature:chat` | `ImageAttachmentValidatorTest` | Photo Picker/share | Chat | Chat phase |
| CHAT-08 | Markdown/code/link/image rendering semantics match fixtures | `feature:chat` | `RenderingParityTest` | rich-output gallery | Chat | Chat phase |
| CHAT-09 | Thinking/tool/diff/directory/source/todo/terminal/subagent/task families | `feature:chat` | `RenderingParityTest` | rich-output gallery | Chat | Chat phase |
| CHAT-10 | Copy/share message, code, and image use Android system surfaces | `feature:chat` | `MessageActionTest` | share-sheet matrix | Chat | Chat phase |
| CHAT-11 | Stable row identity and pinned-bottom scroll behavior | `feature:chat` | `TranscriptScrollTest` | long-stream scroll | Chat | Chat phase |
| CHAT-12 | Turn states survive navigation/lifecycle without duplicate terminals | `GatewaySyncEngine` + `feature:chat` | `ChatLifecycleTest` | rotate/background/restore | Chat | Chat phase |
| CHAT-13 | Every new send computes coarse timezone/offset/locale and never waits on location | `ClientLocationSource` + `ChatConnection` | `ClientLocationSourceTest`, `ResumableChatConnectionTest` | timezone/DST send | Foundation | Foundation in progress |
| AGENT-01 | Agent list/loading/empty/offline/error/status | `feature:agents` | `AgentsViewModelTest` | agent list matrix | Surfaces | Surfaces phase |
| AGENT-02 | Complete read-only detail, including grouped described tools | `feature:agents` | `AgentDetailViewModelTest` | detail audit | Surfaces | Surfaces phase |
| AGENT-03 | Create name/model/prompt and edit immutable-name model/prompt | `feature:agents` | `AgentEditorViewModelTest` | agent CRUD | Surfaces | Surfaces phase |
| AGENT-04 | Enable/disable/delete reconcile ambiguous failures | `feature:agents` | `AgentMutationTest` | failure matrix | Surfaces | Surfaces phase |
| AGENT-05 | Memory list/detail/forget is read/delete only | `feature:agents` | `AgentMemoryViewModelTest` | memory audit | Surfaces | Surfaces phase |
| SETTINGS-01 | Gateway ID/name/fingerprint/relay/status/last sync | `feature:settings` | `SettingsViewModelTest` | settings audit | Surfaces | Surfaces phase |
| SETTINGS-02 | Reconnect, approval entry, and Disconnect & Forget | `feature:settings` | `SettingsViewModelTest` | recovery actions | Surfaces | Surfaces phase |
| SETTINGS-03 | Precise location is opt-in, permission-gated, cached, and lifecycle-aware | `feature:settings` + `ClientLocationController` | `SettingsViewModelTest` | permission/settings matrix | Surfaces | Surfaces phase |
| SYNC-01 | Duplicate/contiguous/gap sequence decisions are deterministic | `SequenceReconciler` | `SequenceReconcilerTest` | network handoff | Foundation | Foundation in progress |
| SYNC-02 | Gap replay is bounded; unprovable replay uses canonical replacement | `GatewaySyncEngine` | `GatewaySyncEngineTest` | forced drop/replay | Foundation | Foundation in progress |
| SYNC-03 | Background suspends live work; foreground reconciles; process restore bootstraps | `DefaultAppCoordinator` | `DefaultAppCoordinatorTest` | process eviction/Doze | Foundation | Foundation in progress |
| UX-01 | Compact/medium/expanded adaptive navigation and panes | `feature:*` root UI | `AdaptiveNavigationTest` | phone/tablet/foldable | Surfaces | Surfaces phase |
| UX-02 | Edge-to-edge, IME, hinge, predictive back, keyboard, pointer | `feature:*` root UI | `AndroidInteractionTest` | device interaction matrix | Surfaces | Surfaces phase |
| UX-03 | TalkBack, font scale, dark theme, contrast, reduced motion | `feature:*` semantics | `AccessibilityTest` | accessibility matrix | Surfaces | Surfaces phase |
| PERF-01 | Startup/list/transcript/stream/scroll baselines | `benchmark` | `StartupBenchmark`, `TranscriptBenchmark` | release device matrix | Release | Release phase |
| RELEASE-01 | Clean break removes legacy QR/manual/LAN/private-chat code and dependencies | Android module graph | dependency/source audit | clean install upgrade audit | Release | Release phase |
| RELEASE-02 | User docs and CI describe and enforce the supported Android client | `android/README.md`, Android CI | workflow/docs assertions | setup dry run | Release | Release phase |
| RELEASE-03 | Screenshot and visual-quality audit has no critical/high issue | screenshot matrix | screenshot regression suite | phone/tablet/foldable audit | Release | Release phase |
| RELEASE-04 | Physical Android+iOS/Mission Control cross-client acceptance passes | canonical gateway scenarios | cross-client integration suite | supported phone plus large-screen QA | Release | Release phase |
| PLATFORM-01 | Drag-and-drop has no iOS parity obligation | none | ledger assertion | none | Release | Not applicable on Android |
| PLATFORM-02 | Push/background work beyond foreground correctness is out of scope | none | ledger assertion | none | Release | Not applicable on Android |
