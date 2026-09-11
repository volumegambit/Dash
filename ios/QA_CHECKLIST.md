# Dash iOS Physical-Device QA Checklist

Use this checklist for an installed build on real hardware. Leave a case unchecked until a tester
has observed it directly. Simulator evidence may be linked for layout-only cases, but it does not
replace Keychain, cellular relay, or background execution evidence.

## QA run metadata

- Device model: Not run on physical hardware
- OS version: Not run on physical hardware
- Build commit: Record at execution time
- Date: Not run
- Tester: Not assigned
- Evidence links: None yet

## Sign-in and security

- [ ] Fresh install -> tapping Sign In opens the browser sheet; completing sign-in shows the gateway picker
- [ ] Empty account (no gateways enrolled) -> shows "No gateways linked to your account yet. Open Mission Control → Settings → Devices → Remote access to enroll this machine."
- [ ] Control plane unreachable while loading gateways -> shows "Couldn't reach your Dash account service. Check your connection and try again." with a working Retry
- [ ] Tap a gateway whose chat capability was never registered (simulate a pre-web enrollment) -> shows "This gateway needs to be re-enrolled from Mission Control before app access works."; opening Mission Control once on that gateway's machine heals it automatically, and the same gateway then connects
- [ ] Connect to an enrolled gateway on cellular (no local Wi-Fi) -> HTTPS/WSS chat succeeds through the relay
- [ ] Revoke this device in Mission Control -> Dash shows "Session no longer authorized" and offers "Sign in again from the gateway list, or Disconnect & Forget this gateway, then try again."; Disconnect & Forget, then reconnect from the gateway picker without a QR code
- [ ] Sign Out on the gateway picker -> disconnects any active gateway, drops the cached account token, and returns to Sign In
- [ ] App termination/relaunch -> selected gateway profile and device-only Keychain credential remain usable
- [ ] Uninstall/reinstall -> app starts signed out and never reconnects from Keychain material alone
- [ ] Disconnect & Forget -> Keychain item and gateway cache are removed; account sign-in state is unaffected

## Signer devices

- [ ] Sign in on a fresh device with no other signer on the account -> connecting to a gateway succeeds immediately, no approval needed
- [ ] Sign in to the web client on a browser while the account already has a signer device -> web shows "Approve this device" with "Waiting for approval — scan this code with the Dash app on your phone." and a QR code with a live countdown
- [ ] On the signed-in device, open Settings and tap "Approve a device" -> camera opens
- [ ] Scan the web client's QR code -> confirm sheet shows `Allow "<device>" to access <gateway>?` naming the browser and gateway; tapping Approve lets the browser through within a couple of seconds
- [ ] Tap Deny on the confirm sheet instead -> web shows "Approval declined. You can try again from the gateway list."
- [ ] Let the web countdown reach zero without scanning -> web shows "The code expired. Try again from the gateway list."
- [ ] Scan an already-expired code from "Approve a device" -> shows "This code has expired. Ask the device to try again."
- [ ] Scan a non-Dash QR code from "Approve a device" -> shows "That's not a Dash approval code." and lets you try again without dismissing the screen

## Conversation synchronization

- [ ] Start on iOS -> appears in Mission Control with identical transcript
- [ ] Start on Mission Control -> appears on iOS with identical transcript
- [ ] Background iOS during stream -> foreground replays without duplicates
- [ ] Simultaneous send -> second client shows active-turn conflict
- [ ] Rename/delete conflict -> stale client refreshes canonical state

## Device quality

- [ ] Attach four valid images; reject per-file and aggregate oversize cases
- [ ] VoiceOver labels status and announces final response once
- [ ] Largest Dynamic Type does not clip sign-in, chat, agent, or settings flows
- [ ] Reduce Motion removes nonessential streaming/navigation animation

## iPad hardware

Everything below needs real hardware or a real input device. Nothing here is coverable by
XCUITest, which is why each row exists rather than being a test. The first two rows replace the
older "iPad split view works in full screen and multitasking widths" and "Hardware keyboard -> Tab
traversal, Return-to-send, and cancel shortcuts work on iPad" entries, which said the same things
less precisely.

- [ ] Hardware keyboard -> ⌘Return sends the composer's text and Esc stops a streaming turn, and
      each is inert exactly when its on-screen control is disabled
- [ ] Hold ⌘ on a connected hardware keyboard -> the overlay lists every case of
      `KeyboardCommand` with its real title: ⌘N New Conversation, ⌘F Search Conversations,
      ⌘⇧[ / ⌘⇧] Previous / Next Conversation, ⌘, Settings…, ⌘1 Conversations, ⌘2 Agents,
      ⌘W Close Conversation, ⌘Return Send, Esc Stop Response, ⌘L Focus Message Field,
      ⌘⇧C Copy Last Response — each enabled or greyed to match its on-screen control. XCUITest
      cannot synthesise hardware key chords, so the table is only unit-tested
      (`DashCommandsTests`); this is the sole check that the overlay actually renders it
- [ ] With a hardware keyboard and **Full Keyboard Access** on, Tab through the conversation list,
      the agent list, and the sidebar footer -> every row takes focus exactly once, in visual
      order, with a visible focus ring, and none is skipped or focused twice. This row exists
      because an explicit focus modifier was deliberately removed rather than shipped unverified —
      treat a regression here as a blocker, not a polish item
- [ ] With a trackpad or mouse attached, hover over conversation rows, agent rows, sidebar footer
      rows and toolbar buttons -> each shows its pointer effect and the cursor changes shape; no
      row is left inert. Pointer interaction cannot be driven in the simulator
- [ ] Drag an image out of Photos in Split View and drop it on the chat composer -> it attaches;
      dropping past the four-attachment limit is rejected with the same message an in-app pick is
- [ ] Slide Over, and Split View at both 1/3 and 1/2 width -> the layout collapses to the compact
      single-column presentation and back without losing the open conversation or its draft
- [ ] Stage Manager -> resize the window continuously across the compact/regular boundary; the
      open conversation, scroll position and draft all survive every crossing
- [ ] Two windows open on the SAME conversation (from "Open in New Window") -> a streaming reply
      renders in both, with no duplicated or dropped messages in either
- [ ] Floating (undocked/minimised) keyboard -> the composer stays visible and the send button
      stays reachable; the transcript is not left scrolled behind the keyboard

## Speech — dictation and read aloud

- [ ] Tap the mic button with microphone permission not yet decided -> iOS presents its permission
      prompt; recording starts once you allow it
- [ ] Deny microphone access (or with access previously denied) -> Dash shows "Microphone access
      is off. Turn it on in Settings." with a **Settings** button that opens the app's iOS Settings
      page
- [ ] Start a recording and let it run without tapping anything -> it auto-finishes at 60 seconds
      and the transcript is inserted, exactly as if the checkmark had been tapped
- [ ] Record dictation over AirPods or another Bluetooth input -> the recording uses that input and
      transcribes correctly
- [ ] Receive a phone call (or another audio interruption) while recording -> the recording stops
      and Dash shows "Recording was interrupted."
- [ ] Choose **Read aloud** on an assistant message -> audio plays and the context menu item
      becomes **Stop reading**; tapping it stops playback
- [ ] Start **Read aloud** on a message, then start it on a second message before the first
      finishes -> the first stops immediately and only the second plays
- [ ] Open **Settings → Speech** on a gateway with a speech provider configured -> the screen loads
      the speech-to-text model, text-to-speech model, voice, and language without error
- [ ] Change the speech-to-text model, text-to-speech model, or voice, then force-quit and relaunch
      the app -> the change persisted on the gateway and the screen reflects it on reload
- [ ] Tap **Preview voice** -> the configured voice speaks the sample sentence
- [ ] Set **Language** to **Auto** -> the change saves, and the gateway's stored configuration no
      longer carries a language, so a subsequent dictation is transcribed with the provider's own
      auto-detection
- [ ] Open **Settings** on a gateway without the `speech-v1` capability -> the **Speech** row is
      hidden and the section footer reads "Update your gateway to use speech."

## Voice mode — capture and playback (device only)

`AudioCaptureService` and `AudioPlaybackService`'s PCM path (Task B8) need a real microphone and
a real audio route, so — like dictation and read-aloud above — none of this is exercised on the
simulator; `PCMFramerTests` and `AudioPlaybackServiceTests` cover the byte-level logic only, and
`AudioCaptureTerminationTests` covers only the stream-termination plumbing pattern, not the real
capture actor.

- [ ] Start voice mode and speak -> frames arrive at roughly 10/s (100 ms each); the orb's level
      meter visibly tracks your voice, not a flat line
- [ ] While voice mode is capturing, disconnect the active input (unplug a wired headset, or let
      connected AirPods drop) or let a phone call interrupt -> capture ends immediately rather
      than continuing to listen on the old route or silently hanging. Plugging in a NEW input
      device does not stop capture on its own
- [ ] While the agent is speaking, start talking (barge-in) -> playback stops instantly, with no
      trailing audio or delay before the mic is heard again. PCM16 is rendered through a Float32
      mixer connection, so also confirm the agent's voice sounds correct (no static, pitch shift,
      or clipping) — that conversion is new as of fix round 1

## Evidence notes

For each checked item, record the device, OS, build commit, date, tester, and a screenshot or
secret-free log link here. Describe failures without pasting account tokens, pairing payloads,
bearer tokens, relay credentials, Keychain values, or raw diagnostic URLs containing credentials.
