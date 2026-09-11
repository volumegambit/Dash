import SwiftUI

/// The hands-free voice cover (speech Phase B, Task B9).
///
/// Full screen and deliberately almost empty: the whole point of voice mode
/// is that the user is not looking at the phone. What is on screen is there
/// for the moments they DO look — an orb that says the session is alive, one
/// line naming the state, the words in play, and the two controls that are
/// still useful with your hands full.
///
/// Presented by `ChatView` as `.fullScreenCover(item:)` over the transcript,
/// which keeps rendering underneath — the chat screen's conversation
/// subscription has to stay alive under the cover, because the gateway drops
/// the voice turn's OWN subscription to avoid double fan-out (Task B6).
struct VoiceModeView: View {
  /// Reduce Motion stops the orb's breathing and pulse outright — a paused
  /// `TimelineView` asks for no frames at all.
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  let voice: VoiceModeFeature

  var body: some View {
    VStack(spacing: 0) {
      Spacer(minLength: 0)

      orb
        .frame(width: 180, height: 180)
        .padding(.bottom, 32)

      Text(voice.state.phase.title)
        .font(.title3.weight(.medium))
        .foregroundStyle(voice.state.phase.isEnded ? Color.secondary : Color.primary)
        .contentTransition(.opacity)
        .accessibilityIdentifier("chat.voice.state")

      captions
        .padding(.top, 20)

      Spacer(minLength: 0)

      controls
    }
    .padding(.horizontal, 24)
    .padding(.vertical, 32)
    // iPad: the same view, held to a column and centred. Everything above is
    // one vertical rhythm; stretched to 1 024 points it stops being one.
    .frame(maxWidth: DashTheme.Layout.voiceWidth)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color(.systemBackground))
  }
  // No identifier on the cover's ROOT: a bare `.accessibilityIdentifier` on a
  // SwiftUI container collapses it into ONE element and erases every child's
  // identifier with it. An earlier revision named the root `chat.voice.cover`
  // and the whole app's accessibility tree came back as a single unnamed
  // element — six UI tests failed looking for `chat.voice.state`, which was
  // on screen the entire time (see the same trap in `DictationBar`).

  // MARK: - Orb

  private var orb: some View {
    Button {
      voice.tapOrb()
    } label: {
      VoiceOrbView(
        phase: voice.state.phase,
        // `voice.level`, not `voice.state.level`: the meter is its own
        // observable property precisely so its 10-20 writes a second
        // re-render this orb and nothing else on the cover.
        level: voice.level,
        animates: reduceMotion == false
      )
    }
    .buttonStyle(.plain)
    // Only while the assistant is talking is there anything to interrupt —
    // the reducer ignores the tap otherwise, and a live-looking control that
    // does nothing is worse than a quiet one.
    .disabled(voice.state.phase != .speaking)
    // The DRAWING is `accessibilityHidden` (see `VoiceOrbView`); what stays
    // in the tree is this tap target, named by what it does rather than by
    // what it looks like. The state line is what announces "Listening".
    .accessibilityLabel("Interrupt the response")
    .accessibilityIdentifier("chat.voice.orb")
  }

  // MARK: - Captions

  /// Both captions scroll as one. The user's line is secondary and the
  /// assistant's primary: the user already knows what they said — what they
  /// are checking is whether it was HEARD correctly, and what came back.
  ///
  /// Scrolled explicitly to a bottom marker rather than with
  /// `.defaultScrollAnchor(.bottom)`. The anchor also pins SHORT content to
  /// the bottom of the box, which left a first caption floating half a screen
  /// below the state line; this way a short exchange sits under the state
  /// line where it belongs, and a long one still shows its newest words.
  /// Unanimated on purpose — a caption that slides while the assistant is
  /// mid-sentence is harder to read, not easier.
  private var captions: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          if voice.state.userCaption.isEmpty == false {
            Text(voice.state.userCaption)
              .font(.body)
              .foregroundStyle(.secondary)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          if voice.state.assistantCaption.isEmpty == false {
            Text(voice.state.assistantCaption)
              .font(.title3)
              .foregroundStyle(.primary)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          if let error = voice.state.error, voice.state.phase.isEnded == false {
            Label(error, systemImage: "exclamationmark.circle")
              .font(.callout)
              .foregroundStyle(DashTheme.danger)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          Color.clear
            .frame(height: 1)
            .id(Self.captionsEnd)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .scrollIndicators(.hidden)
      .onChange(of: voice.state.assistantCaption) { _, _ in
        proxy.scrollTo(Self.captionsEnd, anchor: .bottom)
      }
      .onChange(of: voice.state.userCaption) { _, _ in
        proxy.scrollTo(Self.captionsEnd, anchor: .bottom)
      }
    }
    .frame(maxHeight: 220)
    // One element, so VoiceOver reads the exchange as a passage rather than
    // making the user swipe between two half-sentences that keep changing.
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("chat.voice.captions")
  }

  // MARK: - Controls

  private var controls: some View {
    HStack(spacing: 48) {
      Button {
        Task { await voice.toggleMute() }
      } label: {
        controlIcon(voice.isMuted ? "mic.slash.fill" : "mic.fill")
      }
      .buttonStyle(.plain)
      .disabled(voice.state.phase.isEnded)
      .accessibilityLabel(voice.isMuted ? "Unmute microphone" : "Mute microphone")
      .accessibilityIdentifier("chat.voice.mute")

      Button {
        Task { await voice.stop() }
      } label: {
        controlIcon("xmark")
      }
      .buttonStyle(.plain)
      .accessibilityLabel("End voice mode")
      .accessibilityIdentifier("chat.voice.close")
    }
  }

  private static let captionsEnd = "chat.voice.captions.end"

  private func controlIcon(_ systemImage: String) -> some View {
    Image(systemName: systemImage)
      .font(.title2)
      .frame(width: 64, height: 64)
      .background(
        Color.secondary.opacity(DashTheme.Opacity.fillMuted),
        in: Circle()
      )
      .contentShape(Circle())
  }
}
