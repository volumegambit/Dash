import Foundation
import Testing
import UIKit
import UniformTypeIdentifiers

@testable import Dash

@Suite("Conversation recovery presentation")
@MainActor
struct ConversationRecoveryPresentationTests {
  @Test("recovery explanation preserves send ambiguity and prevents automatic retry")
  func recoveryExplanationCopy() {
    #expect(
      PendingSendRecoveryPresentation.explanation(for: recovery(draft: "Keep me"))
        == "Dash could not confirm whether this message was sent. This saved copy is kept "
          + "separately and will not be sent automatically. Copy the exact text or share its "
          + "readable images before discarding it."
    )
  }

  @Test("draft conflict recovery explains that both local payloads are preserved")
  func draftConflictExplanationCopy() {
    let recovery = RecoverablePendingSend(
      gatewayID: "gateway",
      conversationID: "deleted",
      conversationTitle: "Deleted conversation",
      agentName: "Agent",
      pendingSend: PendingChatSend(
        turnID: "turn",
        localUserID: "local-user",
        draft: "Earlier message",
        attachments: [],
        createdAt: Date(timeIntervalSince1970: 1)
      ),
      coexistingDraft: ConversationDraft(
        text: "Newer draft",
        attachments: [],
        updatedAt: Date(timeIntervalSince1970: 2)
      ),
      conversationAvailable: false
    )

    #expect(
      PendingSendRecoveryPresentation.explanation(for: recovery)
        == "Dash could not confirm whether the earlier message was sent. A newer draft was also "
          + "saved. Both local copies are kept separately and will not be sent automatically. "
          + "Copy their exact text or share their readable images before discarding this "
          + "recovery item."
    )
  }

  @Test("unreadable recovery explanation never offers unavailable image actions")
  func unreadableRecoveryExplanationCopy() {
    let unreadable = RecoverablePendingSend(
      gatewayID: "gateway",
      conversationID: "corrupt",
      conversationTitle: "Corrupt recovery",
      agentName: "Agent",
      pendingSend: PendingChatSend(
        turnID: "turn",
        localUserID: "local-user",
        draft: "Keep the text",
        attachments: [],
        createdAt: Date(timeIntervalSince1970: 1)
      ),
      attachmentIssue: .unreadableStoredPayload
    )

    #expect(
      PendingSendRecoveryPresentation.explanation(for: unreadable)
        == "Dash could not read this saved message's image data. The exact text is still "
          + "available and will not be sent automatically. Copy it before discarding this "
          + "recovery item. Its unreadable images cannot be previewed or shared."
    )
  }

  @Test("preview key uses immutable attachment metadata rather than payload bytes")
  func previewKeyMetadataSemantics() throws {
    let id = try #require(UUID(uuidString: "018F0F4A-5C42-7A8B-9C01-1234567890AF"))
    let first = RecoveryAttachmentPreviewRequest(
      attachment: PreparedAttachment(
        id: id,
        mediaType: ImageMediaType.png.rawValue,
        data: Data(repeating: 0x00, count: 32)
      ),
      requestedMaxPixelDimension: 512
    )
    let sameMetadataDifferentBytes = RecoveryAttachmentPreviewRequest(
      attachment: PreparedAttachment(
        id: id,
        mediaType: ImageMediaType.png.rawValue,
        data: Data(repeating: 0xFF, count: 32)
      ),
      requestedMaxPixelDimension: 512
    )
    let differentByteCount = RecoveryAttachmentPreviewRequest(
      attachment: PreparedAttachment(
        id: id,
        mediaType: ImageMediaType.png.rawValue,
        data: Data(repeating: 0x00, count: 33)
      ),
      requestedMaxPixelDimension: 512
    )

    #expect(first.key == sameMetadataDifferentBytes.key)
    #expect(first.key != differentByteCount.key)
    #expect(
      Set(Mirror(reflecting: first.key).children.compactMap(\.label))
        == ["attachmentID", "mediaType", "byteCount", "maximumPixelDimension"]
    )
  }

  @Test("exports original undecodable bytes with exact image type and filename")
  func exactAttachmentExports() throws {
    let id = try #require(UUID(uuidString: "018F0F4A-5C42-7A8B-9C01-1234567890AD"))
    let cases: [(mimeType: String, contentType: UTType, extension: String, bytes: Data)] = [
      ("image/jpeg", .jpeg, "jpg", Data([0xFF, 0xD8, 0x00, 0x01])),
      ("image/png", .png, "png", Data([0x89, 0x50, 0x00, 0x02])),
      ("image/gif", .gif, "gif", Data([0x47, 0x49, 0x00, 0x03])),
      ("image/webp", .webP, "webp", Data([0x52, 0x49, 0x00, 0x04])),
    ]

    for value in cases {
      #expect(UIImage(data: value.bytes) == nil)
      let transfer = RecoveryAttachmentTransfer(
        attachment: PreparedAttachment(
          id: id,
          mediaType: value.mimeType,
          data: value.bytes
        )
      )

      #expect(transfer.export.data == value.bytes)
      #expect(transfer.export.mimeType == value.mimeType)
      #expect(transfer.export.contentType == value.contentType)
      #expect(transfer.export.contentType.preferredMIMEType == value.mimeType)
      #expect(
        transfer.export.suggestedFileName
          == "recovered-018F0F4A-5C42-7A8B-9C01-1234567890AD.\(value.extension)"
      )
    }
  }

  @Test("copy action writes the exact saved message")
  func exactClipboardCopy() {
    let clipboard = RecordingRecoveryClipboard()
    let recovery = recovery(draft: "  exact text\nwith whitespace\t ")

    RecoveryClipboardAction(clipboard: clipboard).copy(recovery)

    #expect(clipboard.writes == ["  exact text\nwith whitespace\t "])
  }

  @Test("newer draft copy action writes its exact text separately")
  func exactCoexistingDraftClipboardCopy() {
    let clipboard = RecordingRecoveryClipboard()
    let draft = ConversationDraft(
      text: "  newer draft\nwith whitespace\t ",
      attachments: [],
      updatedAt: Date(timeIntervalSince1970: 2)
    )

    RecoveryClipboardAction(clipboard: clipboard).copy(draft)

    #expect(clipboard.writes == ["  newer draft\nwith whitespace\t "])
  }

  @Test("attachment metadata distinguishes preview and fallback for VoiceOver")
  func attachmentAccessibilityMetadata() throws {
    let id = try #require(UUID(uuidString: "018F0F4A-5C42-7A8B-9C01-1234567890AE"))
    let presentation = RecoveryAttachmentPresentation(
      attachment: PreparedAttachment(id: id, mediaType: "image/gif", data: Data([0x00])),
      ordinal: 2,
      count: 4
    )

    #expect(
      presentation.previewAccessibilityLabel
        == "Recovered image attachment 2 of 4, GIF"
    )
    #expect(
      presentation.fallbackAccessibilityLabel
        == "Recovered image attachment 2 of 4, GIF, preview unavailable"
    )
    #expect(
      presentation.shareAccessibilityLabel
        == "Share recovered image attachment 2 of 4, GIF"
    )
    #expect(
      presentation.previewIdentifier
        == "recovery.preview.018F0F4A-5C42-7A8B-9C01-1234567890AE"
    )
    #expect(
      presentation.fallbackIdentifier
        == "recovery.previewFallback.018F0F4A-5C42-7A8B-9C01-1234567890AE"
    )
    #expect(presentation.previewIdentifier != presentation.fallbackIdentifier)
  }

  @Test("unreadable stored attachment payload is explicitly presented")
  func unreadableStoredAttachmentPresentation() throws {
    let recoveryValue = RecoverablePendingSend(
      gatewayID: "gateway",
      conversationID: "deleted",
      conversationTitle: "Deleted conversation",
      agentName: "Agent",
      pendingSend: PendingChatSend(
        turnID: "turn",
        localUserID: "local-user",
        draft: "Keep the text",
        attachments: [],
        createdAt: Date(timeIntervalSince1970: 1)
      ),
      attachmentIssue: .unreadableStoredPayload
    )

    let presentation = try #require(
      RecoveryAttachmentIssuePresentation(recovery: recoveryValue)
    )

    #expect(presentation.rowLabel == "Saved image attachments unavailable")
    #expect(presentation.title == "Saved attachments unavailable")
    #expect(
      presentation.message
        == "Dash couldn't read the saved image data. The exact message text is still available."
    )
    #expect(
      presentation.accessibilityLabel
        == "Saved image attachments unavailable. The exact message text is still available."
    )
    #expect(presentation.identifier == "recovery.attachmentsUnavailable.deleted")
    #expect(RecoveryAttachmentIssuePresentation(recovery: recovery(draft: "No issue")) == nil)
  }

  @Test("unreadable newer draft attachments keep exact text and identify only that payload")
  func unreadableCoexistingDraftAttachmentPresentation() throws {
    let recoveryValue = RecoverablePendingSend(
      gatewayID: "gateway",
      conversationID: "deleted",
      conversationTitle: "Deleted conversation",
      agentName: "Agent",
      pendingSend: PendingChatSend(
        turnID: "turn",
        localUserID: "local-user",
        draft: "Earlier text",
        attachments: [],
        createdAt: Date(timeIntervalSince1970: 1)
      ),
      coexistingDraft: ConversationDraft(
        text: "Exact newer text",
        attachments: [],
        updatedAt: Date(timeIntervalSince1970: 2)
      ),
      coexistingDraftAttachmentIssue: .unreadableStoredPayload,
      conversationAvailable: false
    )

    let presentation = try #require(
      RecoveryAttachmentIssuePresentation(
        recovery: recoveryValue,
        scope: .coexistingDraft
      )
    )

    #expect(presentation.rowLabel == "Newer draft image attachments unavailable")
    #expect(presentation.title == "Newer draft attachments unavailable")
    #expect(
      presentation.message
        == "Dash couldn't read the newer draft's saved image data. Its exact text is still "
          + "available."
    )
    #expect(
      presentation.accessibilityLabel
        == "Newer draft image attachments unavailable. Its exact text is still available."
    )
    #expect(presentation.identifier == "recovery.draft.attachmentsUnavailable.deleted")
  }

  @Test("preview loader coalesces concurrent requests and reuses its bounded cache")
  func previewLoaderDeduplicatesAndCaches() async throws {
    let attachment = PreparedAttachment(
      id: try #require(UUID(uuidString: "018F0F4A-5C42-7A8B-9C01-1234567890B0")),
      mediaType: ImageMediaType.png.rawValue,
      data: Data([0x01])
    )
    let decoder = ControlledRecoveryPreviewDecoder()
    let loader = RecoveryAttachmentPreviewLoader(
      maximumEntryCount: 4,
      maximumCachedCost: 1_024,
      decoder: { data, target in
        await decoder.decode(data: data, target: target)
      }
    )

    async let first = loader.preview(
      for: attachment,
      requestedMaxPixelDimension: 4_096
    )
    async let second = loader.preview(
      for: attachment,
      requestedMaxPixelDimension: 4_096
    )

    await decoder.waitForCallCount(1)
    #expect(await decoder.callCount == 1)
    #expect(
      await decoder.requestedTargets
        == [RecoveryAttachmentPreviewRequest.maximumPixelDimension]
    )

    let decoded = recoveryPreview(width: 8, height: 4)
    await decoder.resolve(marker: 0x01, with: decoded)
    let (firstResult, secondResult) = await (first, second)

    #expect(firstResult?.pixelWidth == 8)
    #expect(secondResult?.pixelHeight == 4)

    let cached = await loader.preview(
      for: attachment,
      requestedMaxPixelDimension: 4_096
    )
    #expect(cached?.pixelWidth == 8)
    #expect(await decoder.callCount == 1)
  }

  @Test("thumbnail decoder bounds image dimensions and rejects invalid bytes")
  func thumbnailDecoderBoundsAndRejects() async throws {
    let source = UIGraphicsImageRenderer(size: CGSize(width: 1_200, height: 600)).pngData {
      context in
      UIColor.systemBlue.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 1_200, height: 600))
    }

    let preview = try #require(
      await RecoveryAttachmentThumbnailDecoder.decode(
        source,
        maxPixelDimension: 96
      )
    )

    #expect(max(preview.pixelWidth, preview.pixelHeight) <= 96)
    #expect(preview.pixelWidth > preview.pixelHeight)
    #expect(
      await RecoveryAttachmentThumbnailDecoder.decode(
        Data([0x00, 0x01, 0x02]),
        maxPixelDimension: 96
      ) == nil
    )
  }

  @Test("preview cache evicts the least recently used entry at its count bound")
  func previewCacheEvictsAtCountBound() async throws {
    let first = PreparedAttachment(
      id: try #require(UUID(uuidString: "018F0F4A-5C42-7A8B-9C01-1234567890B4")),
      mediaType: ImageMediaType.png.rawValue,
      data: Data([0x41])
    )
    let second = PreparedAttachment(
      id: try #require(UUID(uuidString: "018F0F4A-5C42-7A8B-9C01-1234567890B5")),
      mediaType: ImageMediaType.png.rawValue,
      data: Data([0x42])
    )
    let decoder = ControlledRecoveryPreviewDecoder()
    let loader = RecoveryAttachmentPreviewLoader(
      maximumEntryCount: 1,
      maximumCachedCost: 1_024,
      decoder: { data, target in
        await decoder.decode(data: data, target: target)
      }
    )

    let firstLoad = Task { await loader.preview(for: first) }
    await decoder.waitForCallCount(1)
    await decoder.resolve(marker: 0x41, with: recoveryPreview(width: 4, height: 4))
    _ = await firstLoad.value

    let secondLoad = Task { await loader.preview(for: second) }
    await decoder.waitForCallCount(2)
    await decoder.resolve(marker: 0x42, with: recoveryPreview(width: 4, height: 4))
    _ = await secondLoad.value

    let reloadedFirst = Task { await loader.preview(for: first) }
    await decoder.waitForCallCount(3)
    #expect(await decoder.callCount == 3)
    await decoder.resolve(marker: 0x41, with: recoveryPreview(width: 4, height: 4))
    _ = await reloadedFirst.value
  }

  @Test("preview model ignores stale and cancelled decode completions")
  func previewModelRejectsStaleAndCancelledResults() async throws {
    let firstAttachment = PreparedAttachment(
      id: try #require(UUID(uuidString: "018F0F4A-5C42-7A8B-9C01-1234567890B1")),
      mediaType: ImageMediaType.png.rawValue,
      data: Data([0x11])
    )
    let secondAttachment = PreparedAttachment(
      id: try #require(UUID(uuidString: "018F0F4A-5C42-7A8B-9C01-1234567890B2")),
      mediaType: ImageMediaType.png.rawValue,
      data: Data([0x22])
    )
    let cancelledAttachment = PreparedAttachment(
      id: try #require(UUID(uuidString: "018F0F4A-5C42-7A8B-9C01-1234567890B3")),
      mediaType: ImageMediaType.png.rawValue,
      data: Data([0x33])
    )
    let decoder = ControlledRecoveryPreviewDecoder()
    let loader = RecoveryAttachmentPreviewLoader(
      maximumEntryCount: 4,
      maximumCachedCost: 1_024,
      decoder: { data, target in
        await decoder.decode(data: data, target: target)
      }
    )
    let model = RecoveryAttachmentPreviewModel()
    let firstRequest = RecoveryAttachmentPreviewRequest(attachment: firstAttachment)
    let secondRequest = RecoveryAttachmentPreviewRequest(attachment: secondAttachment)
    let cancelledRequest = RecoveryAttachmentPreviewRequest(attachment: cancelledAttachment)

    let firstLoad = Task { await model.load(firstRequest, using: loader) }
    await decoder.waitForCallCount(1)
    let secondLoad = Task { await model.load(secondRequest, using: loader) }
    await decoder.waitForCallCount(2)

    await decoder.resolve(marker: 0x22, with: recoveryPreview(width: 22, height: 1))
    await secondLoad.value
    await decoder.resolve(marker: 0x11, with: recoveryPreview(width: 11, height: 1))
    await firstLoad.value

    guard case .available(let publishedKey, let publishedPreview) = model.phase else {
      Issue.record("Expected the newest preview to remain published")
      return
    }
    #expect(publishedKey == secondRequest.key)
    #expect(publishedPreview.pixelWidth == 22)

    let cancelledLoad = Task { await model.load(cancelledRequest, using: loader) }
    await decoder.waitForCallCount(3)
    cancelledLoad.cancel()
    await decoder.resolve(marker: 0x33, with: recoveryPreview(width: 33, height: 1))
    await cancelledLoad.value

    guard case .loading(let loadingKey) = model.phase else {
      Issue.record("A cancelled decode must not publish its result")
      return
    }
    #expect(loadingKey == cancelledRequest.key)
  }

  private func recovery(draft: String) -> RecoverablePendingSend {
    RecoverablePendingSend(
      gatewayID: "gateway",
      conversationID: "deleted",
      conversationTitle: "Deleted conversation",
      agentName: "Agent",
      pendingSend: PendingChatSend(
        turnID: "turn",
        localUserID: "local-user",
        draft: draft,
        attachments: [],
        createdAt: Date(timeIntervalSince1970: 1)
      )
    )
  }

  private func recoveryPreview(width: Int, height: Int) -> RecoveryAttachmentPreview {
    let renderer = UIGraphicsImageRenderer(
      size: CGSize(width: CGFloat(width), height: CGFloat(height))
    )
    return RecoveryAttachmentPreview(
      image: renderer.image { context in
        UIColor.systemOrange.setFill()
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
      },
      pixelWidth: width,
      pixelHeight: height
    )
  }
}

private actor ControlledRecoveryPreviewDecoder {
  private struct PendingDecode {
    let marker: UInt8
    let continuation: CheckedContinuation<RecoveryAttachmentPreview?, Never>
  }

  private(set) var callCount = 0
  private(set) var requestedTargets: [Int] = []
  private var pending: [PendingDecode] = []
  private var callWaiters: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []

  func decode(data: Data, target: Int) async -> RecoveryAttachmentPreview? {
    callCount += 1
    requestedTargets.append(target)
    resumeSatisfiedCallWaiters()
    let marker = data.first ?? 0
    return await withCheckedContinuation { continuation in
      pending.append(PendingDecode(marker: marker, continuation: continuation))
    }
  }

  func waitForCallCount(_ count: Int) async {
    guard callCount < count else { return }
    await withCheckedContinuation { continuation in
      callWaiters.append((count, continuation))
    }
  }

  func resolve(marker: UInt8, with preview: RecoveryAttachmentPreview?) {
    guard let index = pending.firstIndex(where: { $0.marker == marker }) else {
      Issue.record("No pending decode for marker \(marker)")
      return
    }
    pending.remove(at: index).continuation.resume(returning: preview)
  }

  private func resumeSatisfiedCallWaiters() {
    var remaining: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []
    for waiter in callWaiters {
      if callCount >= waiter.count {
        waiter.continuation.resume()
      } else {
        remaining.append(waiter)
      }
    }
    callWaiters = remaining
  }
}

@MainActor
private final class RecordingRecoveryClipboard: RecoveryClipboardWriting {
  private(set) var writes: [String] = []

  func write(_ text: String) {
    writes.append(text)
  }
}
