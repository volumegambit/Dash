import SwiftUI
import UIKit

/// Chat UX Phase 4 Task 4 (audit #19): the zoom/pan arithmetic behind
/// `ImageViewerView`, kept pure so it's unit-tested (`ImageViewerTests`)
/// the same way `ConversationSearchFilter` and `ComposeAgentSelection` are —
/// SwiftUI gestures themselves aren't unit-testable, the decisions are.
enum ImageViewerZoom {
  static let minimum: CGFloat = 1
  static let maximum: CGFloat = 4
  /// Double-tap target — far enough in to be useful, short of `maximum` so
  /// a pinch can still go further (matches Photos.app's feel).
  static let doubleTapTarget: CGFloat = 2.5

  static func clamped(_ scale: CGFloat) -> CGFloat {
    min(max(scale, minimum), maximum)
  }

  /// Double-tap toggles between fit and `doubleTapTarget`; anything already
  /// zoomed (past a small tolerance) snaps back to fit.
  static func toggled(from scale: CGFloat) -> CGFloat {
    scale > minimum + 0.01 ? minimum : doubleTapTarget
  }

  /// Pans are only meaningful while zoomed in: at fit (`scale == 1`) the
  /// offset always settles to zero, and beyond that it's clamped so the
  /// image never drifts out of the container (half the overflow each side).
  static func settledOffset(_ offset: CGSize, scale: CGFloat, container: CGSize) -> CGSize {
    guard scale > minimum else { return .zero }
    let maxX = max(0, container.width * (scale - 1) / 2)
    let maxY = max(0, container.height * (scale - 1) / 2)
    return CGSize(
      width: min(max(offset.width, -maxX), maxX),
      height: min(max(offset.height, -maxY), maxY)
    )
  }
}

/// Identifiable wrapper so `.fullScreenCover(item:)` can present one tapped
/// image (thumbnails are keyed by position in `UserMessageView`).
struct ViewerImage: Identifiable, Equatable {
  let id: Int
  let image: UIImage
}

/// Full-screen image viewer (audit #19): pinch to zoom, double-tap to
/// toggle, drag to pan while zoomed, Share (system sheet) and Save to
/// Photos — the affordances Claude's and ChatGPT's iOS viewers give an
/// attached image. Presented via `.fullScreenCover` from `UserMessageView`.
/// Reduce-motion: zoom/pan snaps instead of animating.
struct ImageViewerView: View {
  let image: UIImage
  let onClose: () -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var scale: CGFloat = ImageViewerZoom.minimum
  @State private var gestureScale: CGFloat = 1
  @State private var offset: CGSize = .zero
  @State private var gestureOffset: CGSize = .zero
  @State private var saveState: SaveState = .idle

  private enum SaveState: Equatable {
    case idle, saving, saved, failed
  }

  var body: some View {
    GeometryReader { proxy in
      ZStack {
        Color.black.ignoresSafeArea()
        Image(uiImage: image)
          .resizable()
          .scaledToFit()
          .scaleEffect(ImageViewerZoom.clamped(scale * gestureScale))
          .offset(
            x: offset.width + gestureOffset.width,
            y: offset.height + gestureOffset.height
          )
          .gesture(magnify(in: proxy.size))
          .simultaneousGesture(pan(in: proxy.size))
          .onTapGesture(count: 2) { toggleZoom(in: proxy.size) }
          .accessibilityLabel("Attached image, full screen")
          .accessibilityIdentifier("chat.imageViewer.image")
      }
      .overlay(alignment: .top) { chrome }
    }
    // No identifier on this container: SwiftUI would stamp it onto every
    // child element and erase the buttons' own `chat.imageViewer.*` ids
    // (observed in the UI test hierarchy) — the image element carries the
    // presence marker instead.
    .statusBarHidden()
  }

  private var chrome: some View {
    HStack {
      Button(action: onClose) {
        Image(systemName: "xmark")
          .font(.body.weight(.semibold))
          .frame(width: 44, height: 44)
      }
      .accessibilityLabel("Close")
      .accessibilityIdentifier("chat.imageViewer.close")

      Spacer()

      ShareLink(
        item: Image(uiImage: image),
        preview: SharePreview("Attached image", image: Image(uiImage: image))
      ) {
        Image(systemName: "square.and.arrow.up")
          .frame(width: 44, height: 44)
      }
      .accessibilityLabel("Share image")
      .accessibilityIdentifier("chat.imageViewer.share")

      Button {
        save()
      } label: {
        Image(systemName: saveState == .saved ? "checkmark" : "square.and.arrow.down")
          .frame(width: 44, height: 44)
      }
      .disabled(saveState == .saving)
      .accessibilityLabel(saveLabel)
      .accessibilityIdentifier("chat.imageViewer.save")
    }
    .padding(.horizontal, 8)
    .foregroundStyle(.white)
    .background(.black.opacity(DashTheme.Opacity.scrim), ignoresSafeAreaEdges: .top)
  }

  private var saveLabel: String {
    switch saveState {
    case .idle: "Save to Photos"
    case .saving: "Saving to Photos"
    case .saved: "Saved to Photos"
    case .failed: "Couldn't save to Photos"
    }
  }

  private func magnify(in container: CGSize) -> some Gesture {
    MagnifyGesture()
      .onChanged { value in gestureScale = value.magnification }
      .onEnded { value in
        gestureScale = 1
        withAnimation(reduceMotion ? nil : .snappy) {
          scale = ImageViewerZoom.clamped(scale * value.magnification)
          offset = ImageViewerZoom.settledOffset(offset, scale: scale, container: container)
        }
      }
  }

  private func pan(in container: CGSize) -> some Gesture {
    DragGesture()
      .onChanged { value in
        guard scale > ImageViewerZoom.minimum else { return }
        gestureOffset = value.translation
      }
      .onEnded { value in
        gestureOffset = .zero
        withAnimation(reduceMotion ? nil : .snappy) {
          offset = ImageViewerZoom.settledOffset(
            CGSize(
              width: offset.width + value.translation.width,
              height: offset.height + value.translation.height
            ),
            scale: scale,
            container: container
          )
        }
      }
  }

  private func toggleZoom(in container: CGSize) {
    withAnimation(reduceMotion ? nil : .snappy) {
      scale = ImageViewerZoom.toggled(from: scale)
      offset = ImageViewerZoom.settledOffset(offset, scale: scale, container: container)
    }
  }

  private func save() {
    saveState = .saving
    ImageSaver.shared.save(image) { succeeded in
      saveState = succeeded ? .saved : .failed
    }
  }
}

/// `UIImageWriteToSavedPhotosAlbum` needs an Objective-C completion
/// selector target; this tiny object holds the callback for the one in
/// flight. Requires `NSPhotoLibraryAddUsageDescription` (Info.plist).
@MainActor
final class ImageSaver: NSObject {
  static let shared = ImageSaver()
  private var completions: [ObjectIdentifier: (Bool) -> Void] = [:]

  func save(_ image: UIImage, completion: @escaping (Bool) -> Void) {
    completions[ObjectIdentifier(image)] = completion
    UIImageWriteToSavedPhotosAlbum(image, self, #selector(didFinishSaving(_:error:contextInfo:)), nil)
  }

  @objc private func didFinishSaving(
    _ image: UIImage,
    error: Error?,
    contextInfo: UnsafeRawPointer?
  ) {
    let completion = completions.removeValue(forKey: ObjectIdentifier(image))
    completion?(error == nil)
  }
}
