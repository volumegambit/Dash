---
name: draft-reply
description: Draft a reply to a message, email, or thread that matches the user's tone and intent when the user asks to draft, write, or compose a response.
tags: [assistant, writing, communication]
---

# Draft Reply

## When to use
- The user asks to "draft a reply", "write a response", "respond to this", "reply to them", or "help me answer".
- The user shares an incoming message, email, or thread and wants a reply written for them.
- The user wants help phrasing a sensitive, formal, or tricky response.

## Workflow
1. Gather the inputs:
   - The message being replied to. Use it inline if pasted; otherwise read it with `read` or fetch it with `web_fetch`. If it lives in a PDF/Office file, extract it via the `read-documents` skill first.
   - The user's intent: what they want to accomplish with the reply (accept, decline, ask for more info, push back, confirm, etc.). If this is not stated, ask one concise clarifying question before drafting.
2. Determine tone. Match the register of the incoming message and any examples of the user's own writing they provide. If tone is unspecified, infer from context (a casual chat vs. a client email) and default to clear, warm, and professional. When in doubt about formality, ask.
3. Identify every point in the incoming message that needs a response — questions to answer, requests to address, items to acknowledge. Do not leave any open ask unaddressed.
4. Draft the reply:
   - Open with appropriate acknowledgment, then address each point in a logical order.
   - Keep it as short as the situation allows; remove filler.
   - Use the medium's conventions (greeting + sign-off for email; tighter and lower-ceremony for chat).
   - Write in the first person as the user, in their voice.
5. If anything in the reply depends on a fact you do not have (a date, a decision, a number), insert a clearly marked placeholder like `[CONFIRM DATE]` rather than guessing.
6. Re-read the draft against the incoming message to confirm every ask is handled and the tone fits.

## Output
- The ready-to-send reply, formatted for its medium (subject line + body for email; just the body for chat).
- If you made notable choices or left placeholders, add a brief "Notes" line beneath the draft listing them.
- If the user asked for options, provide 2-3 clearly labeled variants (e.g. Direct / Warm / Brief).

## Guardrails
- Never commit the user to obligations, dates, money, or decisions they did not authorize — use placeholders instead.
- Do not fabricate facts, apologies, or context that was not provided.
- Flag, do not bury, anything the user must verify before sending.
- For emotionally charged or high-stakes replies, keep it measured and offer a softer alternative; let the user decide.
- Do not send the message yourself unless the user explicitly asks and an appropriate send tool is available — drafting stops at the draft.
