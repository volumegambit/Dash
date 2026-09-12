import UniformTypeIdentifiers
import Testing
@testable import Dash

@Suite("Dropped images (iPad goal Phase B, design §2.3)")
struct DroppedImageTests {
  @Test("each contract image type imports to the matching ImageSelection")
  func importsContractTypes() throws {
    for type in [UTType.jpeg, .png, .gif, .webP] {
      let dropped = try DroppedImage(data: Data([0xFF]), contentType: type)
      #expect(dropped.selection.typeIdentifier == type.identifier)
    }
  }

  @Test("a non-image type is rejected")
  func rejectsNonImage() {
    #expect(throws: DroppedImage.ImportError.self) {
      try DroppedImage(data: Data([0x00]), contentType: .pdf)
    }
  }

  @Test("selections preserve drop order")
  func selectionsInOrder() throws {
    let a = try DroppedImage(data: Data([1]), contentType: .png)
    let b = try DroppedImage(data: Data([2]), contentType: .jpeg)
    #expect(DroppedImage.selections(from: [a, b]).map(\.data) == [Data([1]), Data([2])])
  }
}
