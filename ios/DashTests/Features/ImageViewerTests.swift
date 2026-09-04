import CoreGraphics
import Foundation
import Testing

@testable import Dash

/// Chat UX Phase 4 Task 4 (audit #19): the viewer's zoom/pan decisions.
@Suite("ImageViewerZoom (Phase 4 Task 4, audit #19)")
struct ImageViewerZoomTests {
  @Test("clamps the scale to the fit…4x range")
  func clampsScale() {
    #expect(ImageViewerZoom.clamped(0.2) == 1)
    #expect(ImageViewerZoom.clamped(2) == 2)
    #expect(ImageViewerZoom.clamped(9) == 4)
  }

  @Test("double-tap toggles between fit and the 2.5x target")
  func doubleTapToggles() {
    #expect(ImageViewerZoom.toggled(from: 1) == 2.5)
    #expect(ImageViewerZoom.toggled(from: 2.5) == 1)
    #expect(ImageViewerZoom.toggled(from: 3.7) == 1)
  }

  @Test("pan settles to zero at fit and stays inside the overflow while zoomed")
  func panSettles() {
    let container = CGSize(width: 400, height: 800)
    #expect(ImageViewerZoom.settledOffset(CGSize(width: 50, height: 50), scale: 1, container: container) == .zero)
    let clamped = ImageViewerZoom.settledOffset(CGSize(width: 999, height: -999), scale: 2, container: container)
    #expect(clamped == CGSize(width: 200, height: -400))
    let inside = ImageViewerZoom.settledOffset(CGSize(width: 10, height: 20), scale: 2, container: container)
    #expect(inside == CGSize(width: 10, height: 20))
  }
}

@Suite("AttachmentSource (Phase 4 Task 4, audit #19)")
struct AttachmentSourceTests {
  @Test("offers library, camera, and files in that order when a camera exists")
  func withCamera() {
    #expect(AttachmentSource.available(cameraAvailable: true) == [.photoLibrary, .camera, .files])
  }

  @Test("hides the camera entry when the device has none")
  func withoutCamera() {
    #expect(AttachmentSource.available(cameraAvailable: false) == [.photoLibrary, .files])
  }

  @Test("maps a chosen file to a contract image type by extension, or nil")
  func fileMapping() {
    let bytes = Data([1, 2, 3])
    #expect(ImageSelection.fromFile(named: "shot.JPG", data: bytes)?.typeIdentifier == "public.jpeg")
    #expect(ImageSelection.fromFile(named: "anim.webp", data: bytes)?.typeIdentifier == "org.webmproject.webp")
    #expect(ImageSelection.fromFile(named: "notes.txt", data: bytes) == nil)
    #expect(ImageSelection.fromFile(named: "noext", data: bytes) == nil)
  }
}
