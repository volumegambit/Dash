import SwiftUI

/// Entry point for the signed-out app: sign in with the Dash account (Clerk
/// PKCE via `AccountSession`) to reach enrolled gateways. Replaces
/// `ConnectView`/QR-pairing as the primary unpaired-state path; the pairing
/// UI itself is retired in a later task.
struct SignInView: View {
  /// Runs the interactive sign-in flow (`AccountSession.signIn()` under the
  /// hood). Thrown `AccountSessionError.cancelled` is treated as a silent
  /// dismissal, not a failure banner.
  let signIn: () async throws -> Void

  @State private var isSigningIn = false
  @State private var errorMessage: String?

  var body: some View {
    GeometryReader { proxy in
      ScrollView {
        VStack(spacing: 28) {
          Spacer()

          VStack(spacing: 16) {
            Image(systemName: "person.crop.circle.badge.checkmark")
              .font(.system(size: 68, weight: .medium))
              .symbolRenderingMode(.hierarchical)
              .foregroundStyle(DashTheme.accent)
              .accessibilityHidden(true)

            VStack(spacing: 8) {
              Text("Sign in to Dash")
                .font(.largeTitle.bold())
                .multilineTextAlignment(.center)
              Text("Sign in with your Dash account to reach the gateways you've enrolled.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            }
          }

          Button {
            Task { await signInTapped() }
          } label: {
            HStack {
              if isSigningIn {
                ProgressView()
                  .tint(.white)
              }
              Text(isSigningIn ? "Signing In" : "Sign In")
            }
            .frame(maxWidth: .infinity, minHeight: 44)
          }
          .buttonStyle(.borderedProminent)
          .disabled(isSigningIn)
          .accessibilityIdentifier("account.signin")

          if let errorMessage {
            Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
              .font(.subheadline)
              .foregroundStyle(.red)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(16)
              .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
              .accessibilityElement(children: .combine)
          }

          Spacer()
        }
        .frame(minHeight: proxy.size.height)
        .frame(maxWidth: 520)
        .padding(.horizontal, 24)
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity)
      }
    }
    .background(Color(uiColor: .systemGroupedBackground))
    .navigationTitle("Sign In")
    .navigationBarTitleDisplayMode(.inline)
  }

  private func signInTapped() async {
    guard isSigningIn == false else { return }
    errorMessage = nil
    isSigningIn = true
    defer { isSigningIn = false }
    do {
      try await signIn()
    } catch AccountSessionError.cancelled {
      // The user dismissed the system sheet — not an error worth surfacing.
    } catch {
      errorMessage = "Dash couldn't sign you in. Try again."
    }
  }
}
