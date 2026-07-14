# Dash iOS Physical-Device QA Checklist

Use this checklist for an installed build on real hardware. Leave a case unchecked until a tester
has observed it directly. Simulator evidence may be linked for layout-only cases, but it does not
replace camera, Keychain, local-network, cellular relay, or background execution evidence.

## QA run metadata

- Device model: Not run on physical hardware
- OS version: Not run on physical hardware
- Build commit: Record at execution time
- Date: Not run
- Tester: Not assigned
- Evidence links: None yet

## Pairing and security

- [ ] Fresh install: camera denied -> paste/manual fallback remains usable
- [ ] LAN v3 QR on same Wi-Fi -> pinned HTTPS/WSS health, agents, and chat succeed
- [ ] Relay v2 QR on cellular -> HTTPS/WSS chat succeeds
- [ ] Revoke this device in Mission Control -> iOS requests re-pairing
- [ ] Disconnect & Forget -> Keychain item and gateway cache are removed

## Conversation synchronization

- [ ] Start on iOS -> appears in Mission Control with identical transcript
- [ ] Start on Mission Control -> appears on iOS with identical transcript
- [ ] Background iOS during stream -> foreground replays without duplicates
- [ ] Simultaneous send -> second client shows active-turn conflict
- [ ] Rename/delete conflict -> stale client refreshes canonical state

## Device quality

- [ ] Attach four valid images; reject per-file and aggregate oversize cases
- [ ] VoiceOver labels status and announces final response once
- [ ] Largest Dynamic Type does not clip pairing, chat, agent, or settings flows
- [ ] Reduce Motion removes nonessential streaming/navigation animation
- [ ] iPad split view works in full screen and multitasking widths

## Evidence notes

For each checked item, record the device, OS, build commit, date, tester, and a screenshot or
secret-free log link here. Describe failures without pasting pairing payloads, bearer tokens, relay
credentials, Keychain values, or raw diagnostic URLs containing credentials.
