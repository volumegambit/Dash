import SwiftUI
import UIKit

/// A `UITextView`-backed composer text input.
///
/// SwiftUI's `TextField(axis: .vertical)` does NOT deliver hardware Return or
/// Tab to `.onKeyPress`, `.onSubmit` does not fire for `typeKey(.return)` in
/// UI tests, and without `.onSubmit` a hardware Return inserts nothing at all
/// — all three were proven in experiments on 2026-09-13. The only reliable
/// way to intercept Return and Shift+Tab in a multiline text input on iOS is
/// a `UITextView` with `pressesBegan` for modifier-aware key interception.
///
/// What this preserves from the old `TextField`:
/// - Placeholder ("Message")
/// - Two-way draft binding via `text`
/// - Focus binding via `isFocused` (auto-focus, ⌘L)
/// - Auto-grow (1–6 lines, min height 44pt)
/// - `disabled` state
/// - `accessibilityIdentifier("chat.composer")`
/// - Return-key behaviour via `returnKeySends`
///
/// What it adds that `TextField` could not:
/// - Caret-correct newline insertion (the `UITextView` knows its selection)
/// - Modifier-aware key handling (Shift+Return vs plain Return vs ⌘+Return)
/// - Shift+Tab inserts a newline at the caret (caret-correct, not append)
struct ComposerTextInput: UIViewRepresentable {
  @Binding var text: String
  @Binding var isFocused: Bool
  var placeholder: String
  var isDisabled: Bool
  var returnKeySends: Bool
  /// Called when plain Return should send (send mode only). The caller
  /// calls `feature.send()`.
  var onSend: () -> Void
  /// Bumped synchronously before `onSend` fires.
  var onActionFeedback: () -> Void

  func makeUIView(context: Context) -> ComposerTextView {
    let tv = ComposerTextView()
    tv.delegate = context.coordinator
    tv.coordinator = context.coordinator
    tv.placeholder = placeholder
    tv.text = text
    tv.font = .preferredFont(forTextStyle: .body)
    tv.adjustsFontForContentSizeCategory = true
    tv.backgroundColor = .clear
    tv.textContainerInset = UIEdgeInsets(top: 10, left: 8, bottom: 10, right: 8)
    tv.textContainer.lineFragmentPadding = 4
    tv.isScrollEnabled = false
    tv.keyboardType = .default
    tv.autocorrectionType = .default
    tv.autocapitalizationType = .sentences
    tv.smartDashesType = .yes
    tv.smartQuotesType = .yes
    tv.returnKeyType = returnKeySends ? .send : .default
    tv.accessibilityIdentifier = "chat.composer"
    context.coordinator.maxLines = 6
    context.coordinator.returnKeySends = returnKeySends
    return tv
  }

  func updateUIView(_ tv: ComposerTextView, context: Context) {
    context.coordinator.parent = self

    // Sync text from SwiftUI → UITextView ONLY when not actively editing.
    // During typing, the text view is the source of truth; syncing back from
    // the binding would overwrite characters the user has typed since the
    // last `textViewDidChange` dispatch (a race that loses characters).
    // External changes (dictation transcript, draft restore, clear) happen
    // when the text view is NOT first responder.
    if !tv.isFirstResponder, tv.text != text, text != context.coordinator.lastText {
      tv.text = text
      context.coordinator.lastText = text
      context.coordinator.recalcHeight(tv: tv)
    }

    tv.placeholder = placeholder
    tv.isEditable = !isDisabled
    tv.returnKeyType = returnKeySends ? .send : .default
    context.coordinator.returnKeySends = returnKeySends

    // Focus sync from SwiftUI → UITextView
    if isFocused, !tv.isFirstResponder {
      DispatchQueue.main.async { tv.becomeFirstResponder() }
    } else if !isFocused, tv.isFirstResponder {
      tv.resignFirstResponder()
    }
  }

  func makeCoordinator() -> Coordinator {
    Coordinator(parent: self)
  }

  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: ComposerTextInput
    var maxLines: Int = 6
    var returnKeySends: Bool = false
    /// Tracks the last text we synced to the binding, to detect external
    /// changes vs. our own edits in `updateUIView`.
    var lastText: String = ""

    init(parent: ComposerTextInput) {
      self.parent = parent
    }

    /// Handles Return from the SOFTWARE keyboard only. Hardware Return is
    /// intercepted in `pressesBegan` (which fires before this method on iOS
    /// 17+ for hardware keys, and does NOT fire for software keyboard events).
    /// For the on-screen keyboard: a newline character as replacementText
    /// means the user tapped the return key. We route it the same way.
    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText: String) -> Bool {
      if replacementText == "\n" {
        // If modifier flags are set, this came from a hardware key that
        // `pressesBegan` already handled — block the duplicate.
        if ComposerTextView.currentModifierFlags != [] {
          return false
        }
        // Software keyboard Return: no modifiers possible.
        if returnKeySends {
          parent.onActionFeedback()
          parent.onSend()
          return false
        } else {
          return true  // insert the newline at the caret
        }
      }
      // Tab: handled in `pressesBegan`. Block the tab character.
      if replacementText == "\t" {
        return false
      }
      return true
    }

    func textViewDidChange(_ textView: UITextView) {
      let newText = textView.text ?? ""
      lastText = newText
      // Defer the SwiftUI binding update to the next runloop tick to avoid
      // a re-render during typing that can cause focus loss in
      // UIViewRepresentable. The text view is the source of truth while
      // editing; the binding catches up asynchronously.
      DispatchQueue.main.async { self.parent.text = newText }
      recalcHeight(tv: textView)
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
      DispatchQueue.main.async { self.parent.isFocused = true }
    }

    func textViewDidEndEditing(_ textView: UITextView) {
      DispatchQueue.main.async { self.parent.isFocused = false }
    }

    func recalcHeight(tv: UITextView) {
      let lineHeight = tv.font?.lineHeight ?? 20
      let contentHeight = tv.contentSize.height
      let padding = tv.textContainerInset.top + tv.textContainerInset.bottom
      let textHeight = contentHeight - padding
      let lineCount = max(1, Int(round(textHeight / lineHeight)))

      if lineCount >= maxLines {
        tv.isScrollEnabled = true
      } else {
        tv.isScrollEnabled = false
      }
      tv.invalidateIntrinsicContentSize()
    }
  }
}

/// A `UITextView` subclass that:
/// - Draws a placeholder when empty
/// - Tracks modifier flags via `pressesBegan` (the reliable way to get
///   Shift/⌘ state on iOS)
/// - Handles Shift+Tab by inserting a newline at the caret
class ComposerTextView: UITextView {
  var placeholder: String = "" {
    didSet { setNeedsDisplay() }
  }
  weak var coordinator: ComposerTextInput.Coordinator?

  /// The modifier flags from the most recent key press. Set in
  /// `pressesBegan`, read by the delegate's `shouldChangeTextIn`.
  /// This bridges the gap: `shouldChangeTextIn` receives the replacement
  /// text but NOT the modifier flags, while `pressesBegan` receives both
  /// the key and modifiers but fires before `shouldChangeTextIn`.
  static var currentModifierFlags: UIKeyModifierFlags = []

  override init(frame: CGRect, textContainer: NSTextContainer?) {
    super.init(frame: frame, textContainer: textContainer)
    NotificationCenter.default.addObserver(
      self, selector: #selector(textDidChangeForPlaceholder),
      name: UITextView.textDidChangeNotification, object: self
    )
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    NotificationCenter.default.addObserver(
      self, selector: #selector(textDidChangeForPlaceholder),
      name: UITextView.textDidChangeNotification, object: self
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  @objc private func textDidChangeForPlaceholder() {
    setNeedsDisplay()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    setNeedsDisplay()
  }

  override func draw(_ rect: CGRect) {
    super.draw(rect)

    if text.isEmpty {
      let attrs: [NSAttributedString.Key: Any] = [
        .font: font ?? .preferredFont(forTextStyle: .body),
        .foregroundColor: UIColor.placeholderText,
      ]
      let inset = self.textContainerInset
      let padding = self.textContainer.lineFragmentPadding
      let drawRect = CGRect(
        x: inset.left + padding,
        y: inset.top,
        width: rect.width - inset.left - inset.right - 2 * padding,
        height: rect.height - inset.top - inset.bottom
      )
      (placeholder as NSString).draw(in: drawRect, withAttributes: attrs)
    }
  }

  // MARK: - Text insertion interception

  /// Updates the text view's text and notifies the delegate/binding.
  /// The binding update is deferred to avoid focus loss during typing.
  private func insertNewlineAtCaret() {
    let sel = selectedRange
    let nsText = (text as NSString)
    let newText = nsText.replacingCharacters(in: sel, with: "\n")
    text = newText
    selectedRange = NSRange(location: sel.location + 1, length: 0)
    coordinator?.lastText = newText
    DispatchQueue.main.async { self.coordinator?.parent.text = newText }
    delegate?.textViewDidChange?(self)
  }

  /// XCUITest's `typeKey` may use `insertText:` to inject characters,
  /// bypassing both `pressesBegan` and `shouldChangeTextIn`. This override
  /// catches that path for Return (\n) and Tab (\t).
  override func insertText(_ text: String) {
    if text == "\n" {
      let modifiers = Self.currentModifierFlags
      let shift = modifiers.contains(.shift)
      let command = modifiers.contains(.command)
      let returnKeySends = coordinator?.returnKeySends ?? false

      if command {
        super.insertText(text)
        return
      }
      if shift || !returnKeySends {
        insertNewlineAtCaret()
        return
      }
      if returnKeySends {
        coordinator?.parent.onActionFeedback()
        coordinator?.parent.onSend()
        return
      }
    }

    if text == "\t" {
      // Tab character: replace with a newline. On a real device, Shift+Tab
      // fires `pressesBegan` (which handles the modifier check), but
      // `typeText("\t")` in XCUITest sends the character directly via
      // `insertText:` without modifier info. Since the composer should never
      // contain a literal tab character (plain Tab moves focus, Shift+Tab
      // inserts a newline), any tab reaching `insertText:` is treated as a
      // newline insertion.
      insertNewlineAtCaret()
      return
    }

    super.insertText(text)
  }

  // MARK: - Key press interception

  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    for press in presses {
      if let key = press.key {
        Self.currentModifierFlags = key.modifierFlags

        // Shift+Tab: insert a newline at the caret and consume the press.
        if key.characters == "\t" && key.modifierFlags.contains(.shift) {
          insertNewlineAtCaret()
          return
        }

        // Plain Tab: let the responder chain handle focus traversal.
        if key.characters == "\t" && !key.modifierFlags.contains(.shift) {
          super.pressesBegan(presses, with: event)
          return
        }

        // Return key: handle here for ALL cases (plain, Shift, ⌘).
        if key.characters == "\r" || key.characters == "\n" {
          let shift = key.modifierFlags.contains(.shift)
          let command = key.modifierFlags.contains(.command)
          let returnKeySends = coordinator?.returnKeySends ?? false

          // ⌘Return: let the send button's .keyboardShortcut handle it
          if command {
            super.pressesBegan(presses, with: event)
            return
          }

          // Shift+Return: always insert a newline at the caret
          if shift {
            insertNewlineAtCaret()
            return
          }

          // Plain Return: the user's setting decides
          if returnKeySends {
            coordinator?.parent.onActionFeedback()
            coordinator?.parent.onSend()
            return
          } else {
            insertNewlineAtCaret()
            return
          }
        }
      }
    }
    super.pressesBegan(presses, with: event)
  }
}
