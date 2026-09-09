import CoreTransferable
import Foundation
import UniformTypeIdentifiers

/// An image dropped onto the chat from Photos, Files, Safari or another app
/// (design §2.3). Only the contract's four image types import; everything
/// else is refused by the type system so the composer never sees it.
struct DroppedImage: Transferable, Sendable {
  enum ImportError: Error, Equatable { case unsupportedType(String) }

  let selection: ImageSelection

  init(data: Data, contentType: UTType) throws {
    guard let supported = ImageSelection.firstSupportedType(in: [contentType]) else {
      throw ImportError.unsupportedType(contentType.identifier)
    }
    selection = ImageSelection(data: data, type: supported)
  }

  static var transferRepresentation: some TransferRepresentation {
    DataRepresentation(importedContentType: .jpeg) { try DroppedImage(data: $0, contentType: .jpeg) }
    DataRepresentation(importedContentType: .png) { try DroppedImage(data: $0, contentType: .png) }
    DataRepresentation(importedContentType: .gif) { try DroppedImage(data: $0, contentType: .gif) }
    DataRepresentation(importedContentType: .webP) { try DroppedImage(data: $0, contentType: .webP) }
  }

  static func selections(from items: [DroppedImage]) -> [ImageSelection] {
    items.map(\.selection)
  }
}
