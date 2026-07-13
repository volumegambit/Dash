import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct ComposerView: View {
  @Environment(ChatFeature.self) private var feature

  @State private var selectedItems: [PhotosPickerItem] = []
  @State private var pickerError: String?

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
          .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 18))
          .disabled(feature.draftEditingAllowed == false)
          .accessibilityIdentifier("chat.composer")
          .submitLabel(.send)
          .onSubmit {
            guard feature.canSend else { return }
            Task { await feature.send() }
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

  private var photoPicker: some View {
    let remaining = ImageAttachmentValidator.maximumCount - feature.state.attachments.count
    return PhotosPicker(
      selection: $selectedItems,
      maxSelectionCount: max(1, remaining),
      matching: .images
    ) {
      Image(systemName: "photo.badge.plus")
        .font(.title3)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .disabled(remaining == 0 || feature.draftEditingAllowed == false)
    .accessibilityLabel("Add images")
    .accessibilityHint("Choose up to four JPEG, PNG, GIF, or WebP images")
    .accessibilityIdentifier("chat.attachments")
  }

  @ViewBuilder
  private var primaryAction: some View {
    if feature.state.activeTurnID != nil, feature.state.composerBlock == nil {
      Button {
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
      .accessibilityLabel(feature.isCancelling ? "Cancelling response" : "Cancel response")
      .accessibilityIdentifier("chat.cancel")
    } else {
      Button {
        Task { await feature.send() }
      } label: {
        Image(systemName: "arrow.up.circle.fill")
          .font(.title2)
          .frame(width: 44, height: 44)
      }
      .disabled(feature.canSend == false)
      .accessibilityLabel("Send message")
      .accessibilityIdentifier("chat.send")
    }
  }

  @ViewBuilder
  private var draftStatus: some View {
    switch feature.draftStatus {
    case .saved:
      Label("Draft saved", systemImage: "checkmark.circle")
        .font(.caption)
        .foregroundStyle(.secondary)
    case .saving:
      Label("Saving draft", systemImage: "arrow.triangle.2.circlepath")
        .font(.caption)
        .foregroundStyle(.secondary)
    case .failed:
      Label("Draft couldn't be saved", systemImage: "exclamationmark.circle")
        .font(.caption)
        .foregroundStyle(.red)
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
      .background(Color.secondary.opacity(0.1))
      .clipShape(RoundedRectangle(cornerRadius: 12))

      Button(action: onRemove) {
        Image(systemName: "xmark.circle.fill")
          .symbolRenderingMode(.palette)
          .foregroundStyle(.white, .black.opacity(0.7))
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
