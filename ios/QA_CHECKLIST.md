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
- [ ] iPad split view works in full screen and multitasking widths
- [ ] Hardware keyboard -> Tab traversal, Return-to-send, and cancel shortcuts work on iPad

## Evidence notes

For each checked item, record the device, OS, build commit, date, tester, and a screenshot or
secret-free log link here. Describe failures without pasting account tokens, pairing payloads,
bearer tokens, relay credentials, Keychain values, or raw diagnostic URLs containing credentials.
