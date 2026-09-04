import SwiftUI

struct StatusBadge: View {
  let title: LocalizedStringKey
  let systemImage: String
  let color: Color

  var body: some View {
    Label {
      Text(title)
    } icon: {
      Image(systemName: systemImage)
    }
    .font(.footnote.weight(.semibold))
    .foregroundStyle(color)
    .accessibilityElement(children: .combine)
  }
}
