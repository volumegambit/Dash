---
name: deep-research
description: Run multi-source web research that fans out across sub-questions and synthesizes a cited answer when the user asks to research, investigate, or find out about a topic in depth.
tags: [assistant, research, web]
---

# Deep Research

## When to use
- The user asks to "research", "investigate", "do a deep dive on", "find out everything about", or "compare options for" a topic.
- A question needs evidence from multiple independent sources rather than a single lookup.
- The user wants a synthesized, cited answer they can trust and verify.

## Workflow
1. Scope the question. Restate what the user wants in one sentence. If it is underspecified (missing budget, region, timeframe, use case, or definition of "best"), ask 1-3 clarifying questions before searching.
2. Decompose into sub-questions. Break the topic into 3-7 concrete sub-questions that together answer the main question. Record them with `todowrite` as a checklist so progress is visible; mark each in_progress when you start it and completed when answered.
3. For each sub-question:
   - Run `web_search` with focused queries. Vary phrasing across at least two searches when results are thin or one-sided.
   - Open the most credible, relevant results with `web_fetch` to read the actual content — do not rely on search snippets alone.
   - Prefer primary sources, official docs, peer-reviewed or reputable outlets, and recent material. Note the publication date.
   - Capture findings with their source URL and the specific claim each source supports.
4. Cross-check. For any consequential or contested claim, confirm it appears in at least two independent sources. If sources disagree, note the disagreement rather than picking one silently.
5. Watch for staleness and bias: flag outdated figures, vendor/marketing pages stating their own product is best, and gaps where you could not find evidence.
6. Synthesize once all sub-questions are answered. Write a direct answer to the main question, supported by the evidence, with citations.

## Output
Markdown report:

```
## Answer
<direct, 2-5 sentence answer to the main question>

## Findings
### <Sub-question 1>
<synthesis with inline citations like [1], [2]>
### <Sub-question 2>
...

## Confidence & gaps
- <how confident, and what could not be verified or remains uncertain>

## Sources
[1] <Title> — <URL> (<date if known>)
[2] ...
```

Scale depth to the request; a quick investigation can be a few paragraphs, a thorough one fuller. Always cite.

## Guardrails
- Never assert a fact without a source you actually fetched and read; do not cite from memory.
- Do not present a single source as consensus — distinguish "one source says" from "widely reported".
- Call out paywalled, inaccessible, or low-quality sources instead of guessing their contents.
- Keep your own opinions out of Findings; reserve any judgment for a clearly labeled recommendation if asked.
- If after reasonable effort the evidence is insufficient, say so plainly rather than padding with weak sources.
