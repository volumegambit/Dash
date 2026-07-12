import SwiftUI

struct RootView: View {
  static let title = "Dash"

  var body: some View {
    Text(Self.title)
      .tint(Color(red: 37 / 255, green: 99 / 255, blue: 235 / 255))
  }
}
