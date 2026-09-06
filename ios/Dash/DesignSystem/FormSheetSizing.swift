import SwiftUI

/// Sizes a presented sheet as a **form** on iPad so it reads as a form rather
/// than a scaled-up phone card (design §1.1 for Settings, §4 for the agent and
/// model pickers).
///
/// Apply this to the sheet's CONTENT — the view inside the `.sheet { }`
/// closure — the same way `presentationDetents` is applied. Chained onto the
/// presenting view instead it silently does nothing.
///
/// `presentationSizing` is iOS 18+; on iOS 17 (the deployment target) the
/// system default sizing stands, which is the documented fallback.
struct FormSheetSizing: ViewModifier {
  func body(content: Content) -> some View {
    if #available(iOS 18.0, *) {
      content.presentationSizing(.form)
    } else {
      content
    }
  }
}
