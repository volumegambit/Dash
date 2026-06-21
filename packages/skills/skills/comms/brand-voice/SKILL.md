---
name: brand-voice
description: Rewrite a draft so it matches a defined brand voice or style guide — use when the user asks to make text on-brand, match a brand's tone, or apply a voice/style guide to copy.
tags: [comms]
---

# Brand Voice

## When to use
- The user asks to make a draft "on-brand", "match our voice", "match our tone", or "apply our style guide".
- A piece of copy (email, post, announcement, landing page, reply) needs to sound like it came from a specific brand or person.
- The user shares a brand/style document and wants existing text aligned to it.

## Workflow
1. Identify the draft to rewrite. If the user pasted it inline, use it directly. If they reference a file, read it with `read`. If you have neither a draft nor a clear request to write one from scratch, ask the user for the text first.
2. Find the voice definition before rewriting. In order:
   - If the user named or attached a brand/style guide, read it (`read` for a local file, `web_fetch` for a URL).
   - If not, look in the workspace for an obvious guide — use `find` / `grep` for files like `brand`, `voice`, `style-guide`, `tone`, `STYLEGUIDE.md`, or a `brand/` directory.
   - If you still have no guide, do NOT guess. Ask the user for 3–5 voice attributes — e.g. "Give me 3–5 words for the voice (e.g. warm, plain-spoken, confident, witty, technical), plus anything to always avoid (jargon, exclamation marks, emoji, hype)."
3. Extract a concrete checklist from whatever you found: tone adjectives, point of view (we/you/I), sentence length and rhythm, vocabulary to prefer and to avoid, formatting habits (sentence case vs. title case, oxford comma, emoji policy), and any hard rules (banned words, required disclaimers, reading level).
4. Rewrite the draft against that checklist. Preserve the original meaning, facts, names, numbers, links, and any call to action — change how it sounds, not what it says. Keep roughly the same length unless the voice calls for tighter or longer copy.
5. Re-read your rewrite against the checklist line by line and fix anything that drifts. Make sure no banned words slipped in and every hard rule holds.
6. If two attributes conflict (e.g. "concise" but a required three-paragraph disclaimer), follow the hard rule and note the tension to the user.

## Output
Lead with the rewritten copy in a clean block the user can copy as-is. Then, briefly:

```
## Rewrite
<the on-brand version>

## What changed
- <voice attribute applied> → <what you did about it>
- <attribute> → <change>

## Flags
- <anything the user should confirm: a fact you couldn't verify, a hard rule that conflicted, a placeholder to fill>
```

If the user only wanted the rewrite, give just the Rewrite block. Honor any length or format the user specified over this template.

## Guardrails
- Never invent the brand voice. If no guide exists and the user has not given attributes, ask — do not default to generic "professional" copy.
- Change tone, not substance. Do not add claims, drop facts, alter numbers, or weaken a call to action while restyling.
- Respect hard rules absolutely: banned words, required disclaimers, reading level, and emoji/punctuation policy override stylistic preferences.
- Do not over-polish into hype. "On-brand" means matching the defined voice, not maximizing enthusiasm.
- Flag placeholders and unverifiable claims rather than silently filling them in.
- If you applied attributes the user gave verbally (no written guide), restate them in "What changed" so the user can correct your reading.
