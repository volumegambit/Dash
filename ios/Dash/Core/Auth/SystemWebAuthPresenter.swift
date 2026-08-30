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
  /// while the system sheet is on screen. Also doubles as the re-entrancy
  /// guard below.
  private var activeSession: ASWebAuthenticationSession?

  func authenticate(url: URL, callbackScheme: String) async throws -> URL {
    // A second concurrent sign-in attempt would otherwise silently orphan
    // the first continuation (its session stays retained, its completion
    // handler never fires, and `activeSession` gets clobbered) — fail the
    // new attempt fast instead.
    guard activeSession == nil else {
      throw AccountSessionError.exchangeFailed
    }

    return try await withCheckedThrowingContinuation { continuation in
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
      // Deliberate: force a fresh sign-in every time rather than silently
      // reusing a previously-authenticated Safari session — this also
      // suppresses the one-time "<app> Wants to Use “clerk.accounts.dev” to
      // Sign In" consent alert non-ephemeral sessions show on first launch.
      // MC's own PKCE flow (a loopback HTTP server + the user's regular
      // browser) has no equivalent "ephemeral" concept to diverge from; this
      // is an iOS-only choice, made for a cleaner one-tap sign-in UX.
      session.prefersEphemeralWebBrowserSession = true
      activeSession = session
      guard session.start() else {
        // `start()` returns false synchronously (e.g. no foreground scene to
        // present from) WITHOUT ever invoking the completion handler above —
        // left unguarded, the continuation would hang forever with no way
        // to recover (this is the app's only entry point when signed out).
        activeSession = nil
        continuation.resume(throwing: AccountSessionError.exchangeFailed)
        return
      }
    }
  }

  nonisolated func presentationAnchor(
    for session: ASWebAuthenticationSession
  ) -> ASPresentationAnchor {
    // Deliberately routed through `self.activeSession` rather than the
    // `session` parameter directly: `ASWebAuthenticationSession` isn't
    // `Sendable`, and `session` is a non-isolated (task-local) value here —
    // sending it into the `@MainActor` closure below would trip strict
    // concurrency's data-race check. `self` already promises `Sendable`
    // (`@unchecked`), and `self.activeSession` is the SAME session object
    // the system just asked an anchor for.
    MainActor.assumeIsolated {
      if let window = Self.presentationWindow() {
        return window
      }
      // No live foreground window to present on (e.g. the scene backgrounded
      // between `start()` succeeding and the system calling us back for an
      // anchor) — never hand back a dead synthetic window that would
      // silently swallow the session and hang `authenticate` forever.
      // Cancelling here drives the completion handler above with an error,
      // which is the closest a non-throwing delegate callback can get to a
      // "throw" path.
      self.activeSession?.cancel()
      return UIWindow()
    }
  }

  /// The current foreground-active scene's key window, falling back to that
  /// scene's first window. Deliberately ignores backgrounded/inactive scenes
  /// (`UIApplication.connectedScenes` is unordered and includes those) so we
  /// never try to present on a scene that can't actually show anything.
  private static func presentationWindow() -> UIWindow? {
    let foregroundScenes = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .filter { $0.activationState == .foregroundActive }
    if let keyWindow = foregroundScenes.flatMap(\.windows).first(where: { $0.isKeyWindow }) {
      return keyWindow
    }
    return foregroundScenes.first?.windows.first
  }
}

extension SystemWebAuthPresenter: ASWebAuthenticationPresentationContextProviding {}
