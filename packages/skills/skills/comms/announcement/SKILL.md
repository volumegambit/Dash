---
name: announcement
description: Draft a clear, well-structured announcement (product launch, update, incident/outage, or policy change) tailored to its audience and channel — use when the user asks to write or draft an announcement, update, or notice.
tags: [comms]
---

# Announcement

## When to use
- The user asks to "write an announcement", "draft an update", "announce X", "post a status update", "send an incident/outage notice", or "tell users about a policy change".
- A change needs to be communicated to a specific audience (customers, users, a team, the public) through a specific channel (email, blog, in-app banner, Slack, status page, social).

## Workflow
1. Identify the four anchors before writing. Infer what you can from the request; ask the user only for what is genuinely missing:
   - **Type**: launch, update/improvement, incident/outage, policy/pricing/terms change, deprecation/sunset, or general news.
   - **Audience**: who reads it, and what they already know.
   - **Channel**: email, blog, in-app, Slack/Teams, status page, social — this sets length, format, and tone.
   - **Key facts**: what changed, why, who is affected, when it takes effect, and what (if anything) the reader must do.
2. Gather missing facts. If details live in a file or thread, read it with `read`; if they live at a URL, fetch it with `web_fetch`. Do not write around a missing date, scope, or action — get it or mark it as a placeholder.
3. Choose the structure for the type:
   - **Launch / update**: hook → what it is → who it's for and the benefit → how to get/use it → availability/price → CTA.
   - **Incident / outage**: current status (investigating / identified / monitoring / resolved) → what's affected and impact → what you're doing → workaround if any → next update time. Lead with status and impact, not apology.
   - **Policy / pricing / terms change**: what's changing → effective date → who is affected and how → what the reader must do and by when → where to get help → link to full details.
   - **Deprecation / sunset**: what's going away → timeline and final date → migration path / alternative → support contact.
4. Write the draft for the channel: a subject line or headline plus body. Front-load the most important information — the reader should grasp what changed and whether they must act within the first two sentences. Keep paragraphs short; use bullets for affected items, dates, and required actions. Match length to the channel (a banner is one line; an email is a few short paragraphs; a blog post can breathe).
5. Tune tone to the type and audience: confident and benefit-led for launches; calm, factual, and accountable for incidents; clear and respectful (no spin) for policy changes. If the workspace has a brand/style guide or the user wants it on-brand, apply the `brand-voice` skill.
6. Close with the next step: a clear CTA, a "what you need to do" line, or a "next update at <time>" for incidents. Re-read to confirm every reader question — what, why, when, who, what-do-I-do — is answered.

## Output
Give a ready-to-send draft:

```
Subject / Headline: <one clear line>

<body — front-loaded, short paragraphs, bullets for actions/dates/scope>

<CTA or "what to do" or "next update at <time>">
```

For incidents, label the status (Investigating / Identified / Monitoring / Resolved) at the top. After the draft, add a short "Before you send" list of any placeholders to fill (dates, links, numbers) and decisions the user should confirm. If the user named a channel with a hard format (e.g. a 280-character post, an in-app banner), honor that limit over this template.

## Guardrails
- State only confirmed facts. Never invent a date, an affected-user count, a root cause, or a resolution time — mark unknowns as `[placeholder]` and list them under "Before you send".
- For incidents, do not assign blame or speculate on root cause before it's confirmed; commit only to a next-update time you can actually meet.
- Make required reader actions and deadlines unmissable — put them in bold or a bullet, not buried in prose.
- Don't bury bad news. For policy, pricing, or deprecation changes, lead with the change and the effective date rather than softening copy.
- Keep it scannable: front-load the point, prefer short sentences, and cut throat-clearing intros.
- If legal/compliance language or a disclaimer may be required (terms, pricing, data, security), flag that the user should have it reviewed — do not draft binding legal text as if it were final.
