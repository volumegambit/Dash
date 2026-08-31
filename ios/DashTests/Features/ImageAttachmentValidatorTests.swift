import Foundation
import Testing
import UniformTypeIdentifiers

@testable import Dash

@Suite("Image attachment validator")
struct ImageAttachmentValidatorTests {
  @Test("accepts four allowed files totaling exactly 12 MiB")
  func acceptsBoundary() throws {
    let inputs = [
      ImageSelection(data: Data(repeating: 1, count: 3_145_728), type: .jpeg),
      ImageSelection(data: Data(repeating: 2, count: 3_145_728), type: .png),
      ImageSelection(data: Data(repeating: 3, count: 3_145_728), type: .gif),
      ImageSelection(data: Data(repeating: 4, count: 3_145_728), type: .webP),
    ]

    let prepared = try ImageAttachmentValidator().prepare(inputs)

    #expect(prepared.count == 4)
    #expect(prepared.reduce(0) { $0 + $1.data.count } == 12_582_912)
  }

  @Test("rejects a fifth file")
  func rejectsFifthFile() {
    let inputs = (0..<5).map { index in
      ImageSelection(data: Data([UInt8(index)]), type: .jpeg)
    }

    #expect(throws: ImageAttachmentValidationError.tooManyFiles(maximum: 4)) {
      try ImageAttachmentValidator().prepare(inputs)
    }
  }

  @Test("rejects a file one byte over 5 MiB")
  func rejectsOversizedFile() {
    let input = ImageSelection(
      data: Data(repeating: 1, count: 5_242_881),
      type: .png
    )

    #expect(
      throws: ImageAttachmentValidationError.fileTooLarge(maximumBytes: 5_242_880)
    ) {
      try ImageAttachmentValidator().prepare([input])
    }
  }

  @Test("rejects a combined payload one byte over 12 MiB")
  func rejectsOversizedCombinedPayload() {
    let inputs = [
      ImageSelection(data: Data(repeating: 1, count: 4_194_304), type: .jpeg),
      ImageSelection(data: Data(repeating: 2, count: 4_194_304), type: .png),
      ImageSelection(data: Data(repeating: 3, count: 4_194_305), type: .gif),
    ]

    #expect(
      throws: ImageAttachmentValidationError.totalTooLarge(maximumBytes: 12_582_912)
    ) {
      try ImageAttachmentValidator().prepare(inputs)
    }
  }

  @Test("rejects HEIC without transcoding")
  func rejectsHEIC() {
    let input = ImageSelection(data: Data([1]), type: .heic)

    #expect(throws: ImageAttachmentValidationError.unsupportedType("public.heic")) {
      try ImageAttachmentValidator().prepare([input])
    }
  }

  @Test("maps supported types to the exact gateway MIME values")
  func mapsMIMETypes() throws {
    let inputs = [
      ImageSelection(data: Data([1]), type: .jpeg),
      ImageSelection(data: Data([2]), type: .png),
      ImageSelection(data: Data([3]), type: .gif),
      ImageSelection(data: Data([4]), type: .webP),
    ]

    let prepared = try ImageAttachmentValidator().prepare(inputs)

    #expect(
      prepared.map(\.mediaType) == [
        "image/jpeg", "image/png", "image/gif", "image/webp",
      ])
    #expect(
      try prepared.map { try $0.messageImage().mediaType } == [
        .jpeg, .png, .gif, .webp,
      ])
  }

  @Test("rejects zero-byte files")
  func rejectsEmptyFile() {
    let input = ImageSelection(data: Data(), type: .jpeg)

    #expect(throws: ImageAttachmentValidationError.emptyFile) {
      try ImageAttachmentValidator().prepare([input])
    }
  }

  @Test("checks raw bytes before base64 expansion")
  func checksRawBytesBeforeBase64() throws {
    let raw = Data(repeating: 7, count: 5_242_880)

    let prepared = try #require(
      ImageAttachmentValidator().prepare([ImageSelection(data: raw, type: .jpeg)]).first
    )
    let encoded = try prepared.messageImage()

    #expect(prepared.data.count == 5_242_880)
    #expect(encoded.data.count > prepared.data.count)
  }
}
