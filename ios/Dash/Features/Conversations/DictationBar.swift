import SwiftUI

/// What the composer shows INSTEAD of its text field while a dictation is
/// running (`docs/plans/2026-09-10-speech-design.md` §4): a live level meter,
/// an `mm:ss` countdown from the 60 s cap, and the two ways out — discard
/// (×) and insert (✓).
///
/// It replaces the field rather than sitting beside it because the field is
/// unusable mid-recording anyway (the transcript has not arrived, and typing
/// under a running meter reads as two competing inputs), and because the
/// replacement is what makes the recording impossible to leave running by
/// accident: the only controls on screen are the two that end it.
struct DictationBar: View {
  let dictation: DictationFeature
  let onCancel: () -> Void
  let onFinish: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      Button(action: onCancel) {
        Image(systemName: "xmark")
          .font(.body.weight(.semibold))
          .frame(width: 44, height: 44)
          .contentShape(Rectangle())
      }
      .accessibilityLabel("Discard recording")
      .accessibilityIdentifier("chat.dictation.cancel")

      meter

      Text(dictation.countdown)
        .font(.callout.monospacedDigit())
        .foregroundStyle(.secondary)
        // The countdown is read as "seconds left", not as a clock time —
        // VoiceOver would otherwise say "zero colon fifty-five".
        .accessibilityLabel("\(dictation.countdown) left")
        .accessibilityIdentifier("chat.dictation.countdown")

      Button(action: onFinish) {
        Image(systemName: "checkmark")
          .font(.body.weight(.semibold))
          .frame(width: 44, height: 44)
          .contentShape(Rectangle())
      }
      .accessibilityLabel("Insert dictation")
      .accessibilityIdentifier("chat.dictation.finish")
    }
    .padding(.horizontal, 4)
    .frame(minHeight: 44)
    .background(
      Color.secondary.opacity(DashTheme.Opacity.fillMuted),
      in: RoundedRectangle(cornerRadius: DashTheme.Radius.xLarge)
    )
    // `.contain` BEFORE the identifier, and both are load-bearing: an
    // identifier on a SwiftUI container otherwise merges its children into
    // one element, which made every control in this bar answer to the
    // container's name and none to its own (caught by `DictationUITests` on
    // the first run). `.contain` keeps the bar addressable as a whole AND
    // leaves × and ✓ individually addressable.
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("chat.dictation.bar")
  }

  /// A bar, not a waveform: the meter's job is to answer "is it hearing me?",
  /// and a level a screen reader cannot describe is decoration — hence the
  /// `.accessibilityHidden` and the spoken countdown beside it.
  private var meter: some View {
    GeometryReader { geometry in
      ZStack(alignment: .leading) {
        Capsule()
          .fill(Color.secondary.opacity(DashTheme.Opacity.fillSubtle))
        Capsule()
          .fill(DashTheme.accent)
          .frame(width: max(2, geometry.size.width * dictation.meterFraction))
          .animation(.easeOut(duration: 0.1), value: dictation.meterFraction)
      }
    }
    .frame(height: 6)
    .frame(maxWidth: .infinity)
    // Hidden, and therefore deliberately unnamed: an identifier on an element
    // no accessibility client can see is dead weight.
    .accessibilityHidden(true)
  }
}

/// The one-line failure state: a message, an optional route to Settings (the
/// only fix for a denied microphone — iOS never prompts twice), and a way to
/// dismiss it. Rendered under the composer rather than over it so the draft
/// stays visible and editable while it is on screen.
struct DictationFailureRow: View {
  let message: String
  let showsSettingsAction: Bool
  let onOpenSettings: () -> Void
  let onDismiss: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      Label(message, systemImage: "exclamationmark.circle")
        .font(.caption)
        .foregroundStyle(.red)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat.dictation.error")

      if showsSettingsAction {
        Button("Settings", action: onOpenSettings)
          .font(.caption.weight(.semibold))
          .accessibilityIdentifier("chat.dictation.settings")
      }

      Spacer(minLength: 0)

      Button(action: onDismiss) {
        Image(systemName: "xmark.circle.fill")
          .foregroundStyle(.secondary)
      }
      .accessibilityLabel("Dismiss dictation error")
      .accessibilityIdentifier("chat.dictation.dismiss")
    }
  }
}
