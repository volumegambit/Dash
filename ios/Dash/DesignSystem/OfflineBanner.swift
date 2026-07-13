import SwiftUI

struct OfflineBanner<Content: View>: View {
  let banner: AppBanner?
  @ViewBuilder let content: Content

  var body: some View {
    content.safeAreaInset(edge: .top, spacing: 0) {
      if let presentation {
        HStack {
          StatusBadge(
            title: presentation.title,
            systemImage: presentation.systemImage,
            color: presentation.color
          )
          Spacer(minLength: 12)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.regularMaterial)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
      }
    }
  }

  private var presentation: Presentation? {
    switch banner {
    case .none:
      nil
    case .offline:
      Presentation(
        title: "Offline — showing saved content", systemImage: "wifi.slash", color: .orange)
    case .gatewayOffline:
      Presentation(title: "Gateway unavailable", systemImage: "server.rack", color: .orange)
    case .rateLimited:
      Presentation(title: "Temporarily rate limited", systemImage: "clock", color: .orange)
    case .repairRequired:
      Presentation(
        title: "Connection needs to be paired again", systemImage: "link.badge.plus", color: .orange
      )
    case .updateRequired:
      Presentation(title: "Dash update required", systemImage: "arrow.down.app", color: .red)
    case .failed:
      Presentation(
        title: "Something went wrong", systemImage: "exclamationmark.triangle", color: .red)
    }
  }

  private struct Presentation {
    let title: LocalizedStringKey
    let systemImage: String
    let color: Color
  }
}
