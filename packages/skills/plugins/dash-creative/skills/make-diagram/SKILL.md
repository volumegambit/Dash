---
name: make-diagram
description: Turn a described process or system into a renderable diagram (Mermaid preferred, ASCII fallback) — use when the user asks for a diagram, flowchart, sequence chart, architecture sketch, or ER model.
tags: [creative, diagram, visualization]
---

# Make Diagram

## When to use
- The user asks to "diagram", "draw", "chart", "map out", or "visualize" a process, flow, system, or data model.
- A description in chat would be clearer as a picture: steps, decisions, components, message exchanges, or entity relationships.
- The user references a specific kind: flowchart, sequence diagram, architecture/component diagram, or entity-relationship (ER) diagram.

Skip when the user wants a real image file, slide deck, or pixel-perfect art — this skill emits text-based diagrams that render in markdown.

## Workflow
1. Identify the diagram type from the request. If unstated, infer from the subject:
   - **Flowchart** — a process with steps and decisions ("how does X work", "the signup flow").
   - **Sequence** — ordered messages between actors/services over time ("client calls API then DB").
   - **Architecture/component** — boxes and connections describing a system's parts.
   - **ER** — data entities, their fields, and relationships ("model for users and orders").
2. Extract the elements: nodes/actors/entities, the edges/messages/relationships between them, and any labels, conditions, or cardinalities. If a critical piece is ambiguous (e.g., direction of a dependency), note your assumption rather than stalling.
3. Choose the rendering format:
   - Default to **Mermaid** in a fenced ```mermaid block — it renders natively in most chat/markdown surfaces.
   - Use **ASCII** (in a plain fenced block) only if the user asks for it, says Mermaid won't render, or the diagram is tiny.
4. Pick the Mermaid syntax for the type: `flowchart TD`/`LR` for flows, `sequenceDiagram` for sequences, `flowchart`/`graph` with subgraphs for architecture, `erDiagram` for ER.
5. Build the diagram: give nodes short stable IDs with readable labels, label edges with the condition or action, group related components with `subgraph`, and keep direction consistent (top-down or left-right).
6. Keep it legible — if there are more than ~15 nodes, split into multiple diagrams or collapse detail, and prefer clarity over completeness.
7. Validate mentally that every referenced node is defined and arrows point the right way before presenting.

## Output
- One fenced ```mermaid block (or ```text for ASCII) containing the complete diagram.
- A one- to two-sentence caption above the block stating what it shows.
- A short "Assumptions" line only if you had to infer anything load-bearing.
- Offer a follow-up: "Want a different layout (LR/TD), more detail, or ASCII instead?"

## Guardrails
- Do not invent components, steps, or relationships the user did not imply — ask if the structure is unclear.
- Never claim to produce an image, PNG, or SVG file; the output is diagram source code that renders as a picture.
- Keep labels free of characters that break Mermaid (escape or rephrase quotes, parentheses, and semicolons inside labels).
- If the request is too vague to diagram (no identifiable steps or parts), ask one focused clarifying question before drawing.
