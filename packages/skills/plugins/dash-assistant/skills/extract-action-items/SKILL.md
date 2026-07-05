---
name: extract-action-items
description: Pull tasks, owners, and due dates out of a transcript or thread into a clear checklist when the user asks for action items, to-dos, or next steps from text.
tags: [assistant, productivity, tasks]
---

# Extract Action Items

## When to use
- The user asks for "action items", "to-dos", "next steps", "follow-ups", or "who owns what" from a meeting, call, chat, or email thread.
- A transcript or thread contains commitments that need to be tracked.
- The user wants a checklist they can act on or hand off.

## Workflow
1. Get the source. Use pasted text directly; otherwise read it with `read` or fetch it with `web_fetch`. For PDF/Office sources, extract text via the `read-documents` skill first. If you cannot find the source, ask the user for it.
2. Read the whole thing, then scan for commitment signals: "I'll", "we need to", "can you", "let's", "by Friday", "TODO", "action:", "follow up on", "next step", assignments, and agreed deadlines.
3. For each action item, capture:
   - Task: a concrete, verb-first description of what must be done.
   - Owner: the person responsible if named or clearly implied; otherwise mark `Unassigned`.
   - Due date: an explicit date/deadline, or a relative one resolved against the source's date when possible; otherwise `No date`.
   - Source cue (optional): a short quote or reference so the user can trace it.
4. Normalize: merge duplicates, split compound items into separate tasks, and drop vague aspirations that are not real commitments. Convert relative dates ("next Tuesday") to concrete dates if the meeting date is known; otherwise keep them relative and note the assumption.
5. If the user asks you to track or create these tasks (and an appropriate tool is available), mirror the checklist into `todowrite`, or create issues with `projects_*` (Linear/GitHub) when they ask for that specifically. Otherwise just present the list.

## Output
A checklist table or list, grouped by owner if there are several people:

```
## Action items
- [ ] <Task> — Owner: <name|Unassigned> — Due: <date|No date>
- [ ] <Task> — Owner: <name|Unassigned> — Due: <date|No date>

## Needs clarification
- <ambiguous commitment that needs an owner or deadline confirmed>
```

Use a Markdown table instead of bullets if the user prefers, or if there are many items with consistent fields.

## Guardrails
- Extract only real commitments. Do not turn discussion, ideas, or "we should maybe" musings into action items unless the user asks for those too.
- Never invent owners or deadlines. Mark them `Unassigned` / `No date` and surface them under "Needs clarification".
- Preserve names, dates, and numbers exactly as stated.
- When a task is ambiguous about who or when, list it but flag it rather than guessing.
- Do not create external tasks or issues unless the user explicitly asks and the tool is available.
