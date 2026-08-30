import AuthenticationServices
import UIKit

/// Presents Clerk's OAuth authorize page in the system browser sheet via
/// `ASWebAuthenticationSession`, resolving with the callback URL once the
/// app's `dash://` custom-scheme redirect fires. This is the concrete,
/// UIKit-backed conformer of `WebAuthPresenting` that `AccountSession` drives
/// in the running app (tests inject fakes instead).
///
/// The whole type is `@MainActor`-isolated: `ASWebAuthenticationSession` must
/// be created, started, and torn down on the main thread, and its
/// `presentationContextProvider` callback is documented to fire there too.
/// `presentationAnchor(for:)` is `nonisolated` only because
/// `ASWebAuthenticationPresentationContextProviding` declares it without
/// actor isolation; `MainActor.assumeIsolated` is safe there because the
/// session only ever invokes it on the main thread.
@MainActor
final class SystemWebAuthPresenter: NSObject, WebAuthPresenting, @unchecked Sendable {
  /// Retained for the lifetime of the in-flight `authenticate` call so
  /// `ASWebAuthenticationSession` isn't deallocated out from under itself
  /// while the system sheet is on screen.
  private var activeSession: ASWebAuthenticationSession?

  func authenticate(url: URL, callbackScheme: String) async throws -> URL {
    try await withCheckedThrowingContinuation { continuation in
      let session = ASWebAuthenticationSession(
        url: url,
        callbackURLScheme: callbackScheme
      ) { [weak self] callbackURL, error in
        self?.activeSession = nil
        if let callbackURL {
          continuation.resume(returning: callbackURL)
          return
        }
        if let authError = error as? ASWebAuthenticationSessionError,
          authError.code == .canceledLogin
        {
          continuation.resume(throwing: WebAuthCancelled())
          return
        }
        continuation.resume(throwing: error ?? AccountSessionError.exchangeFailed)
      }
      session.presentationContextProvider = self
      session.prefersEphemeralWebBrowserSession = true
      activeSession = session
      session.start()
    }
  }

  nonisolated func presentationAnchor(
    for session: ASWebAuthenticationSession
  ) -> ASPresentationAnchor {
    MainActor.assumeIsolated {
      UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .flatMap(\.windows)
        .first { $0.isKeyWindow }
        ?? ASPresentationAnchor()
    }
  }
}

extension SystemWebAuthPresenter: ASWebAuthenticationPresentationContextProviding {}
