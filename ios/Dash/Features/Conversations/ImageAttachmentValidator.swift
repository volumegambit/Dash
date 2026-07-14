import Foundation
import UniformTypeIdentifiers

struct ImageSelection: Equatable, Sendable {
  let data: Data
  let typeIdentifier: String

  init(data: Data, type: UTType) {
    self.data = data
    typeIdentifier = type.identifier
  }

  static func firstSupportedType(in contentTypes: [UTType]) -> UTType? {
    [.jpeg, .png, .gif, .webP].first { candidate in
      contentTypes.contains { $0.identifier == candidate.identifier }
    }
  }
}

enum ImageAttachmentValidationError: Error, Equatable, Sendable {
  case tooManyFiles(maximum: Int)
  case emptyFile
  case unsupportedType(String)
  case fileTooLarge(maximumBytes: Int)
  case totalTooLarge(maximumBytes: Int)
  case invalidPreparedMediaType(String)
}

extension ImageAttachmentValidationError: LocalizedError {
  var errorDescription: String? {
    switch self {
    case .tooManyFiles(let maximum):
      "Choose up to \(maximum) images."
    case .emptyFile:
      "One of the selected images is empty."
    case .unsupportedType:
      "Choose a JPEG, PNG, GIF, or WebP image."
    case .fileTooLarge:
      "Each image must be 5 MB or smaller."
    case .totalTooLarge:
      "Attachments must total 12 MB or less."
    case .invalidPreparedMediaType:
      "One attachment has an unsupported image type."
    }
  }
}

struct ImageAttachmentValidator: Sendable {
  static let maximumCount = 4
  static let maximumFileBytes = 5 * 1_024 * 1_024
  static let maximumTotalBytes = 12 * 1_024 * 1_024

  private let makeID: @Sendable () -> UUID

  init(makeID: @escaping @Sendable () -> UUID = { UUID() }) {
    self.makeID = makeID
  }

  func prepare(_ selections: [ImageSelection]) throws -> [PreparedAttachment] {
    try prepare(selections, appendingTo: [])
  }

  func prepare(
    _ selections: [ImageSelection],
    appendingTo existing: [PreparedAttachment]
  ) throws -> [PreparedAttachment] {
    guard existing.count + selections.count <= Self.maximumCount else {
      throw ImageAttachmentValidationError.tooManyFiles(maximum: Self.maximumCount)
    }

    var totalBytes = try existing.reduce(into: 0) { total, attachment in
      guard attachment.data.isEmpty == false else {
        throw ImageAttachmentValidationError.emptyFile
      }
      guard attachment.data.count <= Self.maximumFileBytes else {
        throw ImageAttachmentValidationError.fileTooLarge(
          maximumBytes: Self.maximumFileBytes
        )
      }
      guard ImageMediaType(rawValue: attachment.mediaType) != nil else {
        throw ImageAttachmentValidationError.invalidPreparedMediaType(attachment.mediaType)
      }
      total += attachment.data.count
    }
    guard totalBytes <= Self.maximumTotalBytes else {
      throw ImageAttachmentValidationError.totalTooLarge(
        maximumBytes: Self.maximumTotalBytes
      )
    }

    var prepared = existing
    prepared.reserveCapacity(existing.count + selections.count)

    for selection in selections {
      guard selection.data.isEmpty == false else {
        throw ImageAttachmentValidationError.emptyFile
      }
      guard selection.data.count <= Self.maximumFileBytes else {
        throw ImageAttachmentValidationError.fileTooLarge(
          maximumBytes: Self.maximumFileBytes
        )
      }

      let mediaType = try gatewayMediaType(for: selection.typeIdentifier)
      totalBytes += selection.data.count
      guard totalBytes <= Self.maximumTotalBytes else {
        throw ImageAttachmentValidationError.totalTooLarge(
          maximumBytes: Self.maximumTotalBytes
        )
      }

      prepared.append(
        PreparedAttachment(
          id: makeID(),
          mediaType: mediaType.rawValue,
          data: selection.data
        )
      )
    }

    return prepared
  }

  private func gatewayMediaType(for typeIdentifier: String) throws -> ImageMediaType {
    switch typeIdentifier {
    case UTType.jpeg.identifier:
      .jpeg
    case UTType.png.identifier:
      .png
    case UTType.gif.identifier:
      .gif
    case UTType.webP.identifier:
      .webp
    default:
      throw ImageAttachmentValidationError.unsupportedType(typeIdentifier)
    }
  }
}

extension PreparedAttachment {
  func messageImage() throws -> MessageImage {
    guard let mediaType = ImageMediaType(rawValue: mediaType) else {
      throw ImageAttachmentValidationError.invalidPreparedMediaType(self.mediaType)
    }
    return MessageImage(mediaType: mediaType, data: data.base64EncodedString())
  }
}
