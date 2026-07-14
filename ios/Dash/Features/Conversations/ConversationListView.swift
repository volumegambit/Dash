import SwiftUI

struct ConversationListView: View {
  @Environment(AppModel.self) private var appModel
  @Environment(ConversationListFeature.self) private var feature
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  @State private var renameTarget: CachedConversation?
  @State private var renameTitle = ""
  @State private var deleteTarget: CachedConversation?

  var body: some View {
    List {
      if feature.conversations.isEmpty {
        emptyState
          .listRowBackground(Color.clear)
      } else {
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

              Button(role: .destructive) {
                deleteTarget = conversation
              } label: {
                Label("Delete", systemImage: "trash")
              }
              .disabled(feature.mutationsAllowed == false)
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
        presentation: horizontalSizeClass == .regular ? .regular : .compact
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
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("conversation.row.\(conversation.id)")
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
