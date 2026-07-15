import CoreTransferable
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct ConversationListView: View {
  @Environment(AppModel.self) private var appModel
  @Environment(ConversationListFeature.self) private var feature

  let presentation: NavigationPresentation

  @State private var renameTarget: CachedConversation?
  @State private var renameTitle = ""
  @State private var deleteTarget: CachedConversation?

  var body: some View {
    List {
      if feature.recoverablePendingSends.isEmpty == false {
        Section("Needs Recovery") {
          ForEach(feature.recoverablePendingSends) { recovery in
            recoveryRow(recovery)
          }
        }
      }

      if feature.conversations.isEmpty, feature.recoverablePendingSends.isEmpty {
        emptyState
          .listRowBackground(Color.clear)
      } else if feature.conversations.isEmpty == false {
        Section("Conversations") {
          ForEach(feature.conversations) { conversation in
            conversationRow(conversation)
              .task {
                await feature.loadOlderIfNeeded(currentID: conversation.id)
              }
              .contextMenu {
                Button {
                  renameTarget = conversation
                  renameTitle = conversation.summary.title
                } label: {
                  Label("Rename", systemImage: "pencil")
                }
                .disabled(feature.mutationsAllowed == false)
                .accessibilityHint(
                  feature.mutationsAllowed ? "" : "Connect to the gateway to rename"
                )

                Button(role: .destructive) {
                  deleteTarget = conversation
                } label: {
                  Label("Delete", systemImage: "trash")
                }
                .disabled(feature.mutationsAllowed == false)
                .accessibilityHint(
                  feature.mutationsAllowed ? "" : "Connect to the gateway to delete"
                )
              }
          }

          if feature.isLoadingOlder {
            HStack {
              Spacer()
              ProgressView("Loading older conversations")
              Spacer()
            }
            .listRowSeparator(.hidden)
          }
        }
      }
    }
    .accessibilityIdentifier("conversation.list")
    .listStyle(.plain)
    .navigationTitle("Conversations")
    .refreshable { await feature.refresh() }
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        agentFilter
      }
      ToolbarItem(placement: .topBarTrailing) {
        NavigationLink(value: ConversationRoute.newConversation) {
          Label("New conversation", systemImage: "square.and.pencil")
            .frame(minWidth: 44, minHeight: 44)
        }
        .disabled(feature.mutationsAllowed == false)
        .accessibilityIdentifier("conversation.new")
        .accessibilityHint(
          feature.mutationsAllowed ? "" : "Connect to the gateway to create a conversation"
        )
      }
    }
    .safeAreaInset(edge: .top) {
      conflictBanner
    }
    .task { await feature.start() }
    .alert("Rename conversation", isPresented: renamePresented) {
      TextField("Title", text: $renameTitle)
      Button("Cancel", role: .cancel) { renameTarget = nil }
      Button("Rename") {
        guard let target = renameTarget else { return }
        renameTarget = nil
        Task { await feature.rename(id: target.id, title: renameTitle) }
      }
    } message: {
      Text("Enter a title for this conversation.")
    }
    .confirmationDialog(
      "Delete \(deleteTarget?.summary.title ?? "conversation")?",
      isPresented: deletePresented,
      titleVisibility: .visible
    ) {
      Button("Delete", role: .destructive) {
        guard let target = deleteTarget else { return }
        deleteTarget = nil
        Task { await feature.delete(id: target.id, confirmed: true) }
      }
      Button("Cancel", role: .cancel) { deleteTarget = nil }
    } message: {
      Text("This removes the conversation while preserving the gateway's canonical history rules.")
    }
    .alert("Conversation update failed", isPresented: genericErrorPresented) {
      Button("OK") { feature.mutationError = nil }
    } message: {
      Text(genericErrorMessage)
    }
    .alert("Recovery update failed", isPresented: recoveryErrorPresented) {
      Button("OK") { feature.recoveryError = nil }
    } message: {
      Text(feature.recoveryError ?? "The saved message remains available.")
    }
  }

  private var renamePresented: Binding<Bool> {
    Binding(
      get: { renameTarget != nil },
      set: { if $0 == false { renameTarget = nil } }
    )
  }

  private var deletePresented: Binding<Bool> {
    Binding(
      get: { deleteTarget != nil },
      set: { if $0 == false { deleteTarget = nil } }
    )
  }

  private var genericErrorPresented: Binding<Bool> {
    Binding(
      get: {
        guard let error = feature.mutationError else { return false }
        if case .revisionConflict = error { return false }
        return true
      },
      set: { if $0 == false { feature.mutationError = nil } }
    )
  }

  private var genericErrorMessage: String {
    switch feature.mutationError {
    case .offline:
      "Connect to the gateway and try again."
    case .invalidTitle:
      "Enter a title that is not empty."
    case .outcomeUnknown:
      "Dash could not confirm the result. Retry to reconcile the same request."
    case .failed, .none:
      "Dash couldn't complete the update. Try again."
    case .revisionConflict:
      ""
    }
  }

  private var recoveryErrorPresented: Binding<Bool> {
    Binding(
      get: { feature.recoveryError != nil },
      set: { if $0 == false { feature.recoveryError = nil } }
    )
  }

  @ViewBuilder
  private var conflictBanner: some View {
    if case .revisionConflict(let current)? = feature.mutationError {
      HStack(spacing: 12) {
        Image(systemName: "arrow.triangle.2.circlepath")
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text("This conversation changed on another device")
            .font(.subheadline.weight(.semibold))
          Text("\(current.title) · \(current.status.displayName)")
            .font(.caption)
        }
        Spacer()
        Button("Retry") {
          Task { await feature.retryConflict() }
        }
        .frame(minWidth: 44, minHeight: 44)
      }
      .padding(.horizontal)
      .background(.regularMaterial)
      .accessibilityElement(children: .combine)
    }
  }

  private var agentFilter: some View {
    Menu {
      Button("All agents") {
        Task { await feature.setAgentFilter(nil) }
      }
      ForEach(feature.agents) { agent in
        Button(agent.name) {
          Task { await feature.setAgentFilter(agent.id) }
        }
      }
    } label: {
      Label("Filter", systemImage: "line.3.horizontal.decrease.circle")
        .frame(minWidth: 44, minHeight: 44)
    }
    .accessibilityValue(selectedAgentName ?? "All agents")
  }

  private var selectedAgentName: String? {
    feature.agents.first { $0.id == feature.selectedAgentID }?.name
  }

  @ViewBuilder
  private var emptyState: some View {
    if feature.mutationsAllowed {
      ContentUnavailableView(
        "No conversations",
        systemImage: "bubble.left.and.bubble.right",
        description: Text("Start a conversation with one of your agents.")
      )
    } else {
      ContentUnavailableView(
        "No cached conversations",
        systemImage: "wifi.slash",
        description: Text("Connect to the gateway to load conversations.")
      )
    }
  }

  private func conversationRow(_ conversation: CachedConversation) -> some View {
    Button {
      appModel.openConversation(
        conversation.id,
        presentation: presentation
      )
    } label: {
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline) {
          Text(conversation.summary.title)
            .font(.headline)
            .foregroundStyle(.primary)
          Spacer()
          Text(conversation.summary.updatedAt, style: .relative)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Text(conversation.summary.agentName)
          .font(.subheadline)
          .foregroundStyle(.secondary)
        if let preview = conversation.summary.lastMessagePreview, preview.isEmpty == false {
          Text(preview)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
        HStack {
          StatusBadge(
            title: LocalizedStringKey(conversation.summary.status.displayName),
            systemImage: conversation.summary.status.systemImage,
            color: conversation.summary.status.color
          )
          if feature.isAuthoritative == false {
            Label("Cached", systemImage: "internaldrive")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      }
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .listRowBackground(
      isSelected(conversation.id) ? DashTheme.accent.opacity(0.12) : Color.clear
    )
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(isSelected(conversation.id) ? .isSelected : [])
    .accessibilityIdentifier("conversation.row.\(conversation.id)")
  }

  private func recoveryRow(_ recovery: RecoverablePendingSend) -> some View {
    Button {
      appModel.openConversationRecovery(
        recovery.conversationID,
        presentation: presentation
      )
    } label: {
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline) {
          Label(recovery.conversationTitle ?? "Recovered message", systemImage: "tray.full")
            .font(.headline)
            .foregroundStyle(.primary)
          Spacer()
          Text(recovery.pendingSend.createdAt, style: .relative)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        if let agentName = recovery.agentName {
          Text(agentName)
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        let preview = recovery.pendingSend.draft.trimmingCharacters(
          in: .whitespacesAndNewlines
        )
        if preview.isEmpty == false {
          Text(preview)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
        if recovery.pendingSend.attachments.isEmpty == false {
          let count = recovery.pendingSend.attachments.count
          Label(
            "\(count) image attachment\(count == 1 ? "" : "s")",
            systemImage: "photo"
          )
          .font(.caption)
          .foregroundStyle(.secondary)
        }
        Text("Saved locally — it will not be sent automatically")
          .font(.caption)
          .foregroundStyle(.orange)
      }
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .listRowBackground(
      isRecoverySelected(recovery.conversationID)
        ? DashTheme.accent.opacity(0.12) : Color.clear
    )
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(isRecoverySelected(recovery.conversationID) ? .isSelected : [])
    .accessibilityHint("Opens the saved message without sending it")
    .accessibilityIdentifier("conversation.recovery.\(recovery.conversationID)")
  }

  private func isSelected(_ conversationID: String) -> Bool {
    guard case .regular = presentation else { return false }
    return appModel.splitConversationSelection == .transcript(conversationID)
  }

  private func isRecoverySelected(_ conversationID: String) -> Bool {
    guard case .regular = presentation else { return false }
    return appModel.splitConversationSelection == .recovery(conversationID)
  }
}

struct PendingSendRecoveryView: View {
  @Environment(AppModel.self) private var appModel
  @Environment(ConversationListFeature.self) private var feature

  let recovery: RecoverablePendingSend
  let presentation: NavigationPresentation

  @State private var showsDiscardConfirmation = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        Label("Saved for recovery", systemImage: "tray.full")
          .font(.headline)
          .foregroundStyle(.orange)

        Text(
          "This message was not sent because its conversation is no longer available. "
            + "Copy the exact text or share its images before discarding it."
        )
        .font(.callout)
        .foregroundStyle(.secondary)

        GroupBox("Message") {
          Text(recovery.pendingSend.draft)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
            .textSelection(.enabled)
            .accessibilityIdentifier("recovery.text.\(recovery.conversationID)")
        }

        Button {
          UIPasteboard.general.string = recovery.pendingSend.draft
        } label: {
          Label("Copy Message", systemImage: "doc.on.doc")
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .accessibilityHint("Copies the exact saved text without sending it")
        .accessibilityIdentifier("recovery.copy.\(recovery.conversationID)")

        if recovery.pendingSend.attachments.isEmpty == false {
          VStack(alignment: .leading, spacing: 12) {
            Text("Image Attachments")
              .font(.headline)
            ForEach(recovery.pendingSend.attachments) { attachment in
              attachmentView(attachment)
            }
          }
        }

        Button(role: .destructive) {
          showsDiscardConfirmation = true
        } label: {
          Label("Discard Recovered Message", systemImage: "trash")
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .disabled(feature.discardingRecoveryID != nil)
        .accessibilityHint("Requires confirmation and permanently removes this local copy")
        .accessibilityIdentifier("recovery.discard.\(recovery.conversationID)")
      }
      .padding()
    }
    .navigationTitle(recovery.conversationTitle ?? "Message Recovery")
    .navigationBarTitleDisplayMode(.inline)
    .confirmationDialog(
      "Discard this recovered message?",
      isPresented: $showsDiscardConfirmation,
      titleVisibility: .visible
    ) {
      Button("Discard Recovered Message", role: .destructive) {
        Task {
          if await feature.discardRecovery(recovery) {
            appModel.closeConversationRecovery(
              recovery.conversationID,
              presentation: presentation
            )
          }
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This permanently removes the saved text and images. It cannot be undone.")
    }
    .alert("Recovery update failed", isPresented: recoveryErrorPresented) {
      Button("OK") { feature.recoveryError = nil }
    } message: {
      Text(feature.recoveryError ?? "The saved message remains available.")
    }
  }

  @ViewBuilder
  private func attachmentView(_ attachment: PreparedAttachment) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if let image = UIImage(data: attachment.data) {
        Image(uiImage: image)
          .resizable()
          .scaledToFit()
          .frame(maxWidth: .infinity, maxHeight: 280)
          .clipShape(RoundedRectangle(cornerRadius: 12))
          .accessibilityLabel("Recovered image attachment")
          .accessibilityIdentifier("recovery.attachment.\(attachment.id.uuidString)")
      } else {
        ContentUnavailableView(
          "Image unavailable",
          systemImage: "photo.badge.exclamationmark",
          description: Text(
            "Dash couldn't preview this saved attachment, but you can still share it."
          )
        )
        .accessibilityIdentifier("recovery.attachment.\(attachment.id.uuidString)")
      }

      ShareLink(
        item: RecoveryAttachmentTransfer(attachment: attachment),
        preview: SharePreview("Recovered image", image: Image(systemName: "photo"))
      ) {
        Label("Share Attachment", systemImage: "square.and.arrow.up")
          .frame(minWidth: 44, minHeight: 44)
      }
      .accessibilityHint("Shares the original saved image without sending the message")
      .accessibilityIdentifier("recovery.share.\(attachment.id.uuidString)")
    }
  }

  private var recoveryErrorPresented: Binding<Bool> {
    Binding(
      get: { feature.recoveryError != nil },
      set: { if $0 == false { feature.recoveryError = nil } }
    )
  }
}

private struct RecoveryAttachmentTransfer: Transferable {
  let id: UUID
  let data: Data
  let mediaType: String

  init(attachment: PreparedAttachment) {
    id = attachment.id
    data = attachment.data
    mediaType = attachment.mediaType
  }

  static var transferRepresentation: some TransferRepresentation {
    DataRepresentation(exportedContentType: .jpeg) { $0.data }
      .exportingCondition { $0.mediaType == ImageMediaType.jpeg.rawValue }
      .suggestedFileName { "recovered-\($0.id.uuidString).jpg" }
    DataRepresentation(exportedContentType: .png) { $0.data }
      .exportingCondition { $0.mediaType == ImageMediaType.png.rawValue }
      .suggestedFileName { "recovered-\($0.id.uuidString).png" }
    DataRepresentation(exportedContentType: .gif) { $0.data }
      .exportingCondition { $0.mediaType == ImageMediaType.gif.rawValue }
      .suggestedFileName { "recovered-\($0.id.uuidString).gif" }
    DataRepresentation(exportedContentType: .webP) { $0.data }
      .exportingCondition { $0.mediaType == ImageMediaType.webp.rawValue }
      .suggestedFileName { "recovered-\($0.id.uuidString).webp" }
    DataRepresentation(exportedContentType: .data) { $0.data }
      .suggestedFileName { "recovered-\($0.id.uuidString)" }
  }
}

extension ConversationStatus {
  fileprivate var displayName: String {
    rawValue.capitalized
  }

  fileprivate var systemImage: String {
    switch self {
    case .idle: "checkmark.circle"
    case .running: "waveform"
    case .interrupted: "exclamationmark.circle"
    case .archived: "archivebox"
    case .deleted: "trash"
    }
  }

  fileprivate var color: Color {
    switch self {
    case .idle: .secondary
    case .running: DashTheme.accent
    case .interrupted: .orange
    case .archived: .secondary
    case .deleted: .red
    }
  }
}
