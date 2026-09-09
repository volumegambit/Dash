import Foundation
import Testing

@testable import Dash

@Suite("Draggable message images (iPad goal Phase B, Task 8)")
struct DraggableMessageImageTests {
  @Test("each contract media type carries its own decoded bytes", arguments: [
    ImageMediaType.jpeg, .png, .gif, .webp,
  ])
  func exportsDecodedBytes(mediaType: ImageMediaType) throws {
    let base64 = Data([0x01, 0x02, 0x03, 0xFF]).base64EncodedString()
    let image = MessageImage(mediaType: mediaType, data: base64)
    let draggable = DraggableMessageImage(image)

    #expect(draggable.mediaType == mediaType)
    #expect(draggable.data == Data(base64Encoded: base64))
  }

  @Test("undecodable base64 yields empty data rather than crashing")
  func undecodableBase64YieldsEmptyData() {
    let image = MessageImage(mediaType: .png, data: "not valid base64!!!")
    let draggable = DraggableMessageImage(image)

    #expect(draggable.data == Data())
    #expect(draggable.mediaType == .png)
  }
}
