---
name: slide-outline
description: Structure a presentation as a slide-by-slide markdown outline with titles, key points, and speaker notes — use when the user asks for a deck, presentation, or slides outline.
tags: [creative, presentation, writing]
---

# Slide Outline

## When to use
- The user asks for a "deck", "presentation", "slides", "pitch", or "talk" and wants the structure or content.
- Someone needs to plan a talk, sales pitch, status update, or lesson before building it in a slide tool.
- The user has notes, a document, or a topic and wants it organized into slides.

This produces a **markdown outline**, not a binary `.pptx` file. State that plainly if the user expects an actual PowerPoint file — they can paste this outline into their slide tool.

## Workflow
1. Clarify three things if not already known (ask in one message, don't stall on each): the **audience**, the **goal/takeaway**, and the **length/time** (which sets roughly one slide per minute, or ask for a target slide count).
2. If the user provided source material (a doc, link, or notes), read or fetch it first so the outline reflects their content rather than generic filler.
3. Choose a narrative arc that fits the goal — common ones: Problem → Solution → Proof → Ask (pitch); Context → Findings → Recommendation (report); Hook → Concepts → Practice → Recap (teaching). Pick one and keep slides in service of it.
4. Draft the slide list. A typical structure: Title slide, Agenda (only if 8+ slides), 1 slide per main idea, and a closing/CTA slide. Aim for one core idea per slide.
5. For each slide write:
   - **Title** — a short, specific headline (assertion-style is stronger than a label: "Churn dropped 30%" beats "Churn").
   - **Key points** — 2–5 terse bullets (the words that appear on the slide), not full paragraphs.
   - **Speaker notes** — 1–3 sentences of what the presenter says or emphasizes, plus any data source or transition cue.
6. Keep on-slide text lean (favor short phrases over sentences); push detail into speaker notes.
7. Do a final pass: confirm the arc holds, each slide earns its place, and the deck ends on the intended takeaway or call to action.

## Output
Markdown, one block per slide, in this shape:

```
## Slide N — <Title>
- <key point>
- <key point>

Speaker notes: <what the presenter says / emphasizes>
```

End with a one-line summary of total slide count and estimated speaking time, plus: "Want me to expand any slide, adjust the length, or change the tone?"

## Guardrails
- Do not produce or claim to produce a `.pptx`/binary file — this is a text outline meant to be pasted into a slide tool.
- Avoid wall-of-text slides; if a slide needs more than ~5 bullets, split it.
- Don't fabricate statistics, quotes, or sources — mark placeholders as `[data needed]` when the user hasn't supplied numbers.
- If audience or goal is unknown and would materially change the structure, ask before drafting rather than guessing.
