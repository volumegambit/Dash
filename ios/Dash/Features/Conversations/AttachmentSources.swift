import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Chat UX Phase 4 Task 4 (audit #19): where a composer image can come
/// from. The picker used to be photo-library-only; Claude and ChatGPT both
/// offer the camera and the Files app too. Ordered as the menu shows them.
enum AttachmentSource: CaseIterable, Equatable, Sendable {
  case photoLibrary
  case camera
  case files

  var title: String {
    switch self {
    case .photoLibrary: "Photo Library"
    case .camera: "Take Photo"
    case .files: "Choose File"
    }
  }

  var systemImage: String {
    switch self {
    case .photoLibrary: "photo.on.rectangle"
    case .camera: "camera"
    case .files: "folder"
    }
  }

  /// The camera entry is hidden (not disabled) on devices without one — the
  /// simulator, most iPads in a dock — rather than presenting a picker that
  /// `UIImagePickerController` would refuse.
  static func available(cameraAvailable: Bool) -> [AttachmentSource] {
    allCases.filter { $0 != .camera || cameraAvailable }
  }

  /// `isSourceTypeAvailable` is main-actor-isolated on the iOS 18 SDK
  /// (Xcode 16.3, which CI pins); the only caller is a SwiftUI body.
  @MainActor static var cameraIsAvailable: Bool {
    UIImagePickerController.isSourceTypeAvailable(.camera)
  }
}

extension ImageSelection {
  /// A file chosen through the Files app: its type comes from the extension
  /// (`UTType(filenameExtension:)`), narrowed to the contract's four image
  /// types through the same `firstSupportedType` the photo picker uses.
  /// `nil` means "not an image we can send" — the composer surfaces that as
  /// the existing unsupported-type copy.
  static func fromFile(named fileName: String, data: Data) -> ImageSelection? {
    let ext = (fileName as NSString).pathExtension
    guard ext.isEmpty == false, let type = UTType(filenameExtension: ext) else { return nil }
    guard let supported = firstSupportedType(in: [type]) else { return nil }
    return ImageSelection(data: data, type: supported)
  }

  /// The Files picker's allow-list — the same four types, in the same
  /// order, as `firstSupportedType`.
  static let importableTypes: [UTType] = [.jpeg, .png, .gif, .webP]
}

/// Camera output encoding (review M6): a 12 MP frame at 0.9 JPEG can pass
/// 5 MB and trip `ImageAttachmentValidator.maximumFileBytes` on every shot.
/// The long edge is bounded first — 2048pt keeps photographic JPEGs well
/// under the limit and is what both reference apps send. Always re-rendered
/// at scale 1 so the encoded pixel size equals the point size regardless of
/// the source image's screen scale.
enum CameraCapture {
  static let maxLongEdge: CGFloat = 2048
  static let jpegQuality: CGFloat = 0.9

  static func jpegData(from image: UIImage) -> Data? {
    let size = image.size
    guard size.width > 0, size.height > 0 else { return nil }
    let longEdge = max(size.width, size.height)
    let ratio = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1
    let target = CGSize(
      width: (size.width * ratio).rounded(.down),
      height: (size.height * ratio).rounded(.down)
    )
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let rendered = UIGraphicsImageRenderer(size: target, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: target))
    }
    return rendered.jpegData(compressionQuality: jpegQuality)
  }
}

/// `UIImagePickerController` in camera mode, wrapped for SwiftUI. Delivers
/// the shot as JPEG bytes (the contract has no HEIC), or nothing on cancel.
struct CameraPicker: UIViewControllerRepresentable {
  let onCapture: (Data?) -> Void

  func makeUIViewController(context: Context) -> UIImagePickerController {
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.delegate = context.coordinator
    return picker
  }

  func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

  func makeCoordinator() -> Coordinator {
    Coordinator(onCapture: onCapture)
  }

  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    let onCapture: (Data?) -> Void

    init(onCapture: @escaping (Data?) -> Void) {
      self.onCapture = onCapture
    }

    func imagePickerController(
      _ picker: UIImagePickerController,
      didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
      let image = info[.originalImage] as? UIImage
      onCapture(image.flatMap(CameraCapture.jpegData(from:)))
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
      onCapture(nil)
    }
  }
}
