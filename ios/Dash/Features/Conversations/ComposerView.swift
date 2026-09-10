import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// What a key does in the composer on iOS (UI-quality goal, Phase D).
///
/// A declaration, not a description: `ComposerView` routes its Shift+Tab
/// branch through `action(key:shift:command:)`, and
/// `ComposerKeyContractTests` cross-checks every case against the `ios`
/// column of `scripts/fixtures/composer-key-contract.json` — the same file
/// the web suite generates its tests from. Changing the behaviour on one side
/// without the other fails the build's tests.
///
/// Why it exists: Shift+Return inserted a newline on web and Mission Control
/// and was silently impossible here, because SwiftUI's `onSubmit` fires on
/// every Return with no modifier awareness. Every test on every client
/// passed. Nothing named the intended behaviour in one place, so nothing
/// could notice one client drifting from it.
enum ComposerKeyContract {
  enum Action: String, Equatable, Sendable {
    /// Submits the draft.
    case send
    /// Inserts a line break; does not submit.
    case newline
    /// Left to the platform's focus traversal; does not touch the draft.
    case focus
  }

  /// How the newline arrives, for cases that produce one.
  enum Mechanism: String, Equatable, Sendable {
    /// This app's own handler inserts it.
    case handler
    /// The platform's text input inserts it; the handler's job is to decline
    /// the key. Declining is exactly what `onSubmit` could not do.
    case native
  }

  static func action(key: String, shift: Bool, command: Bool) -> Action {
    switch (key, shift, command) {
    // ⌘Return sends — the send button carries this shortcut.
    case ("Enter", _, true): .send
    // Return and Shift+Return both insert a newline. `TextField` does it
    // natively once `.onSubmit` is gone; the composer must not intercept.
    case ("Enter", _, false): .newline
    // Shift+Tab is a deliberate override of reverse focus traversal.
    case ("Tab", true, _): .newline
    // Plain Tab is deliberately NOT overridden: taking both directions would
    // leave keyboard and screen-reader users no way out of the composer.
    case ("Tab", false, _): .focus
    default: .focus
    }
  }

  static func mechanism(key: String, shift: Bool, command: Bool) -> Mechanism? {
    guard action(key: key, shift: shift, command: command) == .newline else { return nil }
    // Only Shift+Tab is spliced by this app; Return relies on `TextField`.
    return key == "Tab" ? .handler : .native
  }
}

struct ComposerView: View {
  @Environment(ChatFeature.self) private var feature
  /// Speech is a property of the CONNECTED GATEWAY, not of a conversation:
  /// `AppModel.gatewayCapabilities` is the one place that knows whether this
  /// gateway advertises `speech-v1`, so the mic is gated from here rather
  /// than from `ChatFeature`, which never sees a capability.
  @Environment(AppModel.self) private var appModel

  /// Monotonic counter bumped by `ChatView` when ⌘L
  /// (`KeyboardCommand.focusComposer`) fires. A counter rather than a `Bool`
  /// so repeated ⌘L presses each land: the value always changes, so
  /// `onChange` always runs, even if the field is already focused and the
  /// user has since tapped elsewhere.
  var focusRequest: Int = 0

  /// iPad goal Phase B, Task 8 review fix: shares `ChatView`'s own
  /// `isDropTargeted` state rather than owning a second copy, so the ONE
  /// dashed highlight overlay `ChatView` draws lights up whichever
  /// `.dropDestination` below actually claims the drag. See this file's own
  /// `.dropDestination` below for why the composer needs its own, separate
  /// from `ChatView`'s.
  var isDropTargeted: Binding<Bool> = .constant(false)

  @State private var selectedItems: [PhotosPickerItem] = []
  @State private var pickerError: String?
  // Input sources (Phase 4 Task 4, audit #19): the paperclip is now a menu
  // over `AttachmentSource.available(cameraAvailable:)`; each entry flips
  // one of these to present its picker.
  @State private var isPhotoPickerPresented = false
  @State private var isCameraPresented = false
  @State private var isFileImporterPresented = false
  // Haptics (chat-ux Phase 2, audit #7): bumped synchronously inside the
  // send/cancel button actions (and the composer's Return-key submit),
  // before the `Task { await ... }` kicks off — the tap itself earns the
  // tick regardless of how the async call resolves, matching a physical
  // button's immediate feedback.
  @State private var actionFeedbackTick = 0
  // Compose-first new chat (Task 3, audit #16): "keyboard-ready" composer —
  // a brand-new conversation should land with the keyboard already up
  // rather than making the user tap the text field first. Scoped to
  // conversations that have never had a message sent (`isFreshConversation`)
  // so opening an existing, already-used conversation never steals focus
  // out from under the user. `hasAttemptedAutoFocus` makes this a one-shot
  // per `ComposerView` instance (itself one per open conversation, since
  // `ChatView` is `.id(ObjectIdentifier(feature))`-keyed in `RootView`) — it
  // fires as soon as `feature.draftEditingAllowed` first goes true and never
  // refires after that, so a later reconnect or reachability flip toggling
  // that same flag can't yank the keyboard back up after the user's
  // deliberately dismissed it.
  @FocusState private var isDraftFocused: Bool
  @State private var hasAttemptedAutoFocus = false
  #if DEBUG
    /// One-shot, like `hasAttemptedAutoFocus`: `DASH_UI_TEST_DICTATION` seeds
    /// the dictation state exactly once, on whichever pass first finds a
    /// non-nil `feature.dictation` — the capability arrives asynchronously,
    /// so that is often not the first.
    @State private var hasSeededDictation = false
  #endif

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if feature.state.attachments.isEmpty == false {
        attachmentStrip
      }

      HStack(alignment: .bottom, spacing: 8) {
        // While a dictation runs, the field, the attach menu and send are all
        // replaced: the only actions that still make sense are the two that
        // end the recording, and a draft typed over a running meter reads as
        // two inputs competing for the same message.
        if let dictation = feature.dictation, dictation.isBusy {
          if dictation.isUploading {
            transcribingIndicator
          } else {
            DictationBar(
              dictation: dictation,
              onCancel: { Task { await dictation.cancel() } },
              onFinish: { Task { await dictation.finish() } }
            )
          }
        } else {
          if feature.dictation != nil {
            dictationButton
          }

          photoPicker

          TextField("Message", text: draftBinding, axis: .vertical)
            .lineLimit(1...6)
            .textFieldStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(minHeight: 44)
            .background(Color.secondary.opacity(DashTheme.Opacity.fillMuted), in: RoundedRectangle(cornerRadius: DashTheme.Radius.xLarge))
            .disabled(feature.draftEditingAllowed == false)
            .focused($isDraftFocused)
            .accessibilityIdentifier("chat.composer")
            .keyboardShortcut("l", modifiers: .command)
            // Return inserts a newline; ⌘Return sends (the send button already
            // carries that shortcut). Previously `.onSubmit` fired on every
            // Return, and SwiftUI's `onSubmit` has no modifier awareness — so
            // with a hardware keyboard there was NO way to type a newline in
            // the composer at all. `.submitLabel(.send)` goes with it, so the
            // software keyboard's return key stops advertising a send it no
            // longer performs.
            .onKeyPress(keys: [.tab], phases: .down) { press in
              // Through the contract, so the declaration is load-bearing rather
              // than decorative: if the table changes, this branch changes with
              // it and `ComposerKeyContractTests` checks both against the shared
              // fixture.
              let shift = press.modifiers.contains(.shift)
              let action = ComposerKeyContract.action(
                key: "Tab", shift: shift, command: press.modifiers.contains(.command))
              guard action == .newline else { return .ignored }
              guard feature.draftEditingAllowed else { return .ignored }
              // Appends rather than splitting at the caret: SwiftUI's
              // `TextField` does not expose a selection, and reaching one
              // would mean replacing the whole input with a `UITextView`
              // wrapper. Return already gives a caret-correct newline here,
              // so this is the redundant convenience path.
              //
              // Through `updateDraft`, not `state.draft` directly — that is
              // the path `draftBinding` uses, and the one that persists the
              // per-conversation draft.
              Task { await feature.updateDraft(feature.state.draft + "\n") }
              return .handled
            }

          primaryAction
        }
      }

      if let dictation = feature.dictation, let message = dictation.failureMessage {
        DictationFailureRow(
          message: message,
          showsSettingsAction: dictation.showsSettingsAction,
          onOpenSettings: openSettings,
          onDismiss: { dictation.acknowledgeFailure() }
        )
      } else if let message = pickerError ?? feature.composerDisabledReason {
        Label(message, systemImage: pickerError == nil ? "info.circle" : "exclamationmark.circle")
          .font(.caption)
          .foregroundStyle(pickerError == nil ? Color.secondary : Color.red)
          .accessibilityElement(children: .combine)
      } else {
        draftStatus
      }
    }
    .frame(maxWidth: DashTheme.Layout.readableWidth)
    .padding(.horizontal)
    .padding(.vertical, 10)
    .background(.bar)
    // iPad goal Phase B, Task 8 review fix: a drag released over the
    // composer's own `TextField` never reaches `ChatView`'s outer
    // `.dropDestination` (confirmed by `IPadUITests
    // .testDroppingAnImageAttachesIt`, retargeted to each drop location with
    // everything else held constant: failed 3/3 isolated reruns dropping on
    // `chat.composer`, passed 3/3 dropping on `chat.transcript`). What isn't
    // isolated is WHY: it's equally consistent with the `TextField`'s own
    // built-in drop interaction claiming the session first, or with
    // `ChatView`'s destination simply never having had a hit-testable
    // region over the composer's screen area at all — that destination is
    // applied before `ChatView` appends the composer via `.safeAreaInset`,
    // regardless of what view ends up sitting there (review fix round 1,
    // Minor 2 — an earlier version of this comment asserted the
    // `TextField`-claims-it mechanism as fact, which was never actually
    // tested). Either way the fix is the same: this is the SAME "attach the
    // handler locally, everywhere it needs to work" call `ChatCommandActions`
    // 's keyboard shortcuts already made (see `ChatView`'s own comment on
    // that), applied to drag and drop instead of ⌘-shortcuts — this
    // destination handles the composer's own surface directly, through the
    // exact same `addSelections` entry point `ChatView`'s destination uses.
    .dropDestination(for: DroppedImage.self) { items, _ in
      let selections = DroppedImage.selections(from: items)
      guard selections.isEmpty == false else { return false }
      Task { await feature.addSelections(selections) }
      return true
    } isTargeted: { isDropTargeted.wrappedValue = $0 }
    .onChange(of: selectedItems) { _, items in
      guard items.isEmpty == false else { return }
      Task { await load(items) }
    }
    .photosPicker(
      isPresented: $isPhotoPickerPresented,
      selection: $selectedItems,
      maxSelectionCount: max(1, remainingAttachmentSlots),
      matching: .images
    )
    .fullScreenCover(isPresented: $isCameraPresented) {
      CameraPicker { data in
        isCameraPresented = false
        guard let data else { return }
        Task { await addFileSelections([ImageSelection(data: data, type: .jpeg)]) }
      }
      .ignoresSafeArea()
    }
    .fileImporter(
      isPresented: $isFileImporterPresented,
      allowedContentTypes: ImageSelection.importableTypes,
      allowsMultipleSelection: true
    ) { result in
      Task { await importFiles(result) }
    }
    .sensoryFeedback(.impact(weight: .light), trigger: actionFeedbackTick)
    // Design §4: the transcript landing in the draft earns a `.success`, the
    // one moment in dictation where something the user cannot see happened.
    .sensoryFeedback(.success, trigger: feature.dictationInsertTick)
    .task { attemptAutoFocus() }
    .task { updateDictationAvailability() }
    .onChange(of: appModel.speechAvailable) { _, _ in updateDictationAvailability() }
    .onChange(of: feature.draftEditingAllowed) { _, allowed in
      guard allowed else { return }
      attemptAutoFocus()
    }
    // The cached transcript has landed, so `isFreshConversation` can finally
    // be answered truthfully — retry the one-shot auto-focus that was
    // correctly declined while `messages` was empty-because-unloaded.
    .onChange(of: feature.hasLoadedCache) { _, loaded in
      guard loaded else { return }
      attemptAutoFocus()
    }
    // ⌘L. Unlike `attemptAutoFocus()` this is NOT one-shot and is NOT gated
    // on `isFreshConversation`: the user asked for the field explicitly, so
    // honour it every time in any conversation. `focusRequest`'s initial 0
    // never fires `onChange`, so simply opening a chat still can't steal
    // focus.
    .onChange(of: focusRequest) { _, _ in
      isDraftFocused = true
    }
  }

  /// "Never had a message" is only knowable once the cached transcript has
  /// been read — `messages` is empty for every conversation before that, and
  /// deciding on the empty placeholder made existing threads open with the
  /// keyboard up (transcript scroll fix, 2026-09-05).
  private var isFreshConversation: Bool {
    feature.hasLoadedCache && feature.state.messages.isEmpty && feature.state.activeTurnID == nil
  }

  private func attemptAutoFocus() {
    guard hasAttemptedAutoFocus == false else { return }
    guard feature.draftEditingAllowed, isFreshConversation else { return }
    hasAttemptedAutoFocus = true
    isDraftFocused = true
  }

  private var draftBinding: Binding<String> {
    Binding(
      get: { feature.state.draft },
      set: { value in
        Task { await feature.updateDraft(value) }
      }
    )
  }

  private var attachmentStrip: some View {
    ScrollView(.horizontal) {
      HStack(spacing: 10) {
        ForEach(Array(feature.state.attachments.enumerated()), id: \.element.id) {
          index,
          attachment in
          AttachmentThumbnail(attachment: attachment) {
            Task { await feature.removeAttachment(id: attachment.id) }
          }
          .accessibilityLabel("Attached image \(index + 1)")
          // iPad goal Phase B, Task 8 (forwarded from Task 7): lets a UI
          // test assert a specific attachment landed in the composer after
          // a drag-and-drop, the same way `MessageImageView`'s
          // `chat.message.image.<n>` identifies a specific transcript image.
          .accessibilityIdentifier("chat.attachment.\(index)")
        }
      }
      .padding(.vertical, 2)
    }
    .scrollIndicators(.hidden)
  }

  private var remainingAttachmentSlots: Int {
    ImageAttachmentValidator.maximumCount - feature.state.attachments.count
  }

  /// Design §4: the mic sits left of the paperclip, and is disabled by the
  /// same rule the field is — a turn in progress, a read-only conversation or
  /// a blocked composer means there is nothing to dictate INTO.
  private var dictationButton: some View {
    Button {
      actionFeedbackTick += 1
      Task { await feature.dictation?.start() }
    } label: {
      Image(systemName: "mic")
        .font(.title3)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .disabled(feature.draftEditingAllowed == false)
    .accessibilityLabel("Dictate a message")
    .accessibilityHint("Records up to 60 seconds and adds what you say to your message")
    .accessibilityIdentifier("chat.dictate")
  }

  /// The upload. No cancel: the clip is already recorded and the request is
  /// seconds long — the honest thing is to say what is happening and let it
  /// finish. Starting another recording cancels it.
  private var transcribingIndicator: some View {
    HStack(spacing: 8) {
      ProgressView()
      Text("Transcribing…")
        .font(.callout)
        .foregroundStyle(.secondary)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .frame(minHeight: 44)
    .frame(maxWidth: .infinity)
    .background(
      Color.secondary.opacity(DashTheme.Opacity.fillMuted),
      in: RoundedRectangle(cornerRadius: DashTheme.Radius.xLarge)
    )
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Transcribing")
    .accessibilityIdentifier("chat.dictation.uploading")
  }

  private func updateDictationAvailability() {
    feature.syncDictation(available: appModel.speechAvailable)
    #if DEBUG
      seedDictationForUITesting()
    #endif
  }

  #if DEBUG
    /// `DASH_UI_TEST_DICTATION=recording|uploading|failed` drives the REAL
    /// state machine through the UI-test fakes rather than writing a phase
    /// directly, so a capture cannot show a state the app can't reach.
    /// `uploading` hangs in the fake transcriber; `failed` throws from it.
    private func seedDictationForUITesting() {
      guard
        hasSeededDictation == false,
        let seed = UITestLaunchOptions.dictation,
        let dictation = feature.dictation
      else { return }
      hasSeededDictation = true
      Task {
        await dictation.start()
        guard seed != "recording" else { return }
        await dictation.finish()
      }
    }
  #endif

  private func openSettings() {
    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
    UIApplication.shared.open(url)
  }

  /// Audit #19: photo library, camera (when the device has one), or the
  /// Files app — one menu, same `chat.attachments` identifier the old
  /// library-only button had.
  private var photoPicker: some View {
    Menu {
      ForEach(AttachmentSource.available(cameraAvailable: AttachmentSource.cameraIsAvailable), id: \.self) { source in
        Button {
          switch source {
          case .photoLibrary: isPhotoPickerPresented = true
          case .camera: isCameraPresented = true
          case .files: isFileImporterPresented = true
          }
        } label: {
          Label(source.title, systemImage: source.systemImage)
        }
        .accessibilityIdentifier("chat.attachments.\(source)")
      }
    } label: {
      Image(systemName: "photo.badge.plus")
        .font(.title3)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .disabled(remainingAttachmentSlots == 0 || feature.draftEditingAllowed == false)
    .accessibilityLabel("Add images")
    .accessibilityHint("Choose up to four JPEG, PNG, GIF, or WebP images")
    .accessibilityIdentifier("chat.attachments")
  }

  private func importFiles(_ result: Result<[URL], Error>) async {
    do {
      var selections: [ImageSelection] = []
      for url in try result.get() {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        guard let selection = ImageSelection.fromFile(named: url.lastPathComponent, data: data) else {
          throw AttachmentPickerError.unsupportedType
        }
        selections.append(selection)
      }
      await addFileSelections(selections)
    } catch let error as AttachmentPickerError {
      pickerError = error.message
    } catch {
      pickerError = "That file couldn't be loaded. Try another image."
    }
  }

  private func addFileSelections(_ selections: [ImageSelection]) async {
    guard selections.isEmpty == false else { return }
    await feature.addSelections(selections)
    pickerError = nil
  }

  @ViewBuilder
  private var primaryAction: some View {
    if feature.state.activeTurnID != nil, feature.state.composerBlock == nil {
      Button {
        actionFeedbackTick += 1
        Task { await feature.cancel() }
      } label: {
        if feature.isCancelling {
          ProgressView()
            .frame(width: 44, height: 44)
        } else {
          Image(systemName: "stop.circle.fill")
            .font(.title2)
            .frame(width: 44, height: 44)
        }
      }
      .disabled(feature.canCancel == false)
      .keyboardShortcut(.cancelAction)
      .accessibilityLabel(feature.isCancelling ? "Cancelling response" : "Cancel response")
      .accessibilityIdentifier("chat.cancel")
    } else {
      Button {
        actionFeedbackTick += 1
        Task { await feature.send() }
      } label: {
        Image(systemName: "arrow.up.circle.fill")
          .font(.title2)
          .frame(width: 44, height: 44)
      }
      .disabled(feature.canSend == false)
      .keyboardShortcut(.return, modifiers: .command)
      .accessibilityLabel("Send message")
      .accessibilityHint(feature.composerDisabledReason ?? "")
      .accessibilityIdentifier("chat.send")
    }
  }

  // Chrome trim (chat-ux Phase 2, audit #17; tightened 2026-09-04): the
  // debounced autosave flips `.saving`→`.saved` on every keystroke, so a
  // "Saving draft" chip flickered under the composer while typing. A save
  // in flight isn't actionable either — same "silence on success" principle
  // as `TerminalView`'s trim above — so only a FAILED save says anything.
  // Decision lives in `ComposerDraftStatusPresentation` (unit-tested).
  @ViewBuilder
  private var draftStatus: some View {
    if let label = ComposerDraftStatusPresentation.label(for: feature.draftStatus) {
      Label(label.text, systemImage: label.systemImage)
        .font(.caption)
        .foregroundStyle(.red)
    } else {
      EmptyView()
    }
  }

  private func load(_ items: [PhotosPickerItem]) async {
    defer { selectedItems = [] }
    do {
      var selections: [ImageSelection] = []
      selections.reserveCapacity(items.count)
      for item in items {
        guard let type = ImageSelection.firstSupportedType(in: item.supportedContentTypes) else {
          throw AttachmentPickerError.unsupportedType
        }
        guard let data = try await item.loadTransferable(type: Data.self) else {
          throw AttachmentPickerError.unreadable
        }
        selections.append(ImageSelection(data: data, type: type))
      }
      await feature.addSelections(selections)
      pickerError = nil
    } catch let error as AttachmentPickerError {
      pickerError = error.message
    } catch {
      pickerError = "That image couldn't be loaded. Try another image."
    }
  }
}

private struct AttachmentThumbnail: View {
  let attachment: PreparedAttachment
  let onRemove: () -> Void

  var body: some View {
    ZStack(alignment: .topTrailing) {
      Group {
        if let image = UIImage(data: attachment.data) {
          Image(uiImage: image)
            .resizable()
            .scaledToFill()
        } else {
          Image(systemName: "photo.badge.exclamationmark")
            .foregroundStyle(.secondary)
        }
      }
      .frame(width: 64, height: 64)
      .background(Color.secondary.opacity(DashTheme.Opacity.fillSubtle))
      .clipShape(RoundedRectangle(cornerRadius: DashTheme.Radius.medium))

      Button(action: onRemove) {
        Image(systemName: "xmark.circle.fill")
          .symbolRenderingMode(.palette)
          .foregroundStyle(.white, .black.opacity(DashTheme.Opacity.scrim))
          .frame(width: 44, height: 44, alignment: .topTrailing)
          .contentShape(Rectangle())
      }
      .offset(x: 10, y: -10)
      .accessibilityLabel("Remove image")
    }
    .padding(.top, 8)
    .padding(.trailing, 8)
  }
}

private enum AttachmentPickerError: Error {
  case unsupportedType
  case unreadable

  var message: String {
    switch self {
    case .unsupportedType:
      "Choose a JPEG, PNG, GIF, or WebP image."
    case .unreadable:
      "That image couldn't be loaded. Try another image."
    }
  }
}

/// Which draft-status chip (if any) the composer shows — `nil` for both
/// `.saved` and `.saving`, so nothing flickers while typing; only a failed
/// save is worth a line.
enum ComposerDraftStatusPresentation {
  struct ChipLabel: Equatable {
    let text: String
    let systemImage: String
  }

  static func label(for status: ChatDraftStatus) -> ChipLabel? {
    switch status {
    case .saved, .saving:
      nil
    case .failed:
      ChipLabel(text: "Draft couldn't be saved", systemImage: "exclamationmark.circle")
    }
  }
}
