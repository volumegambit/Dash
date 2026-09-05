import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct ComposerView: View {
  @Environment(ChatFeature.self) private var feature

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

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if feature.state.attachments.isEmpty == false {
        attachmentStrip
      }

      HStack(alignment: .bottom, spacing: 8) {
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
            guard press.modifiers.contains(.shift) else { return .ignored }
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

      if let message = pickerError ?? feature.composerDisabledReason {
        Label(message, systemImage: pickerError == nil ? "info.circle" : "exclamationmark.circle")
          .font(.caption)
          .foregroundStyle(pickerError == nil ? Color.secondary : Color.red)
          .accessibilityElement(children: .combine)
      } else {
        draftStatus
      }
    }
    .frame(maxWidth: 760)
    .padding(.horizontal)
    .padding(.vertical, 10)
    .background(.bar)
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
    .task { attemptAutoFocus() }
    .onChange(of: feature.draftEditingAllowed) { _, allowed in
      guard allowed else { return }
      attemptAutoFocus()
    }
    .onChange(of: feature.hasLoadedCache) { _, loaded in
      guard loaded else { return }
      attemptAutoFocus()
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
        }
      }
      .padding(.vertical, 2)
    }
    .scrollIndicators(.hidden)
  }

  private var remainingAttachmentSlots: Int {
    ImageAttachmentValidator.maximumCount - feature.state.attachments.count
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
