---
name: summarize-thread
description: Condense a long conversation, chat thread, or document into key points, decisions, and open questions when the user asks to summarize, recap, or TL;DR a thread or doc.
tags: [assistant, summarization, productivity]
---

# Summarize Thread

## When to use
- The user asks to "summarize", "recap", "TL;DR", "catch me up on", or "give me the gist of" a conversation, chat thread, email thread, or document.
- A long block of text needs to be condensed into something scannable.
- Someone returns to a thread and needs to know what was decided and what is still open.

## Workflow
1. Identify the source. If the user pasted the text inline, use it directly. If they reference a file, read it with `read` (for plain text, markdown, or code). If they reference a remote thread or page, fetch it with `web_fetch`. If the source is a PDF or Office file, hand off to the `read-documents` skill first to extract text. If you cannot locate the source, ask the user to paste it or give a path/URL.
2. Read the entire source before writing anything. Note the participants (or authors), the chronological flow, and any shifts in topic.
3. Extract three categories as you read:
   - Key points: the substantive facts, context, and arguments raised.
   - Decisions made: anything explicitly agreed, chosen, rejected, or committed to — capture who decided when it is clear.
   - Open questions: unresolved issues, pending approvals, unanswered questions, and anything marked TBD.
4. Collapse duplicates and drop pleasantries, sign-offs, and tangents that do not change the outcome.
5. Order key points by importance, not by where they appeared. Keep decisions and open questions in the order they matter to the reader.
6. Calibrate length to the source: a few bullets for a short thread, a tight paragraph plus bullets for a long one. Default to brevity; never pad.

## Output
Markdown with these sections (omit a section only if it is genuinely empty):

```
## Summary
<1-3 sentence overview of what the thread/doc is about and where it landed>

## Key points
- <point>
- <point>

## Decisions made
- <decision> (— who/when, if known)

## Open questions
- <unresolved item>
```

If the user asked for a specific length or format (e.g. "one sentence", "three bullets"), honor that over this template.

## Guardrails
- Summarize only what is in the source. Do not infer decisions that were merely discussed, and do not invent owners or dates.
- Distinguish proposals from decisions — "X suggested Y" is not the same as "we will do Y".
- Preserve numbers, dates, names, and commitments exactly; these are the load-bearing details.
- If the source is ambiguous about whether something was decided, list it under Open questions rather than Decisions.
- Do not editorialize or add recommendations unless the user asks for them.
