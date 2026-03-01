# Extended Thinking

Extended thinking allows the model to reason internally before producing a visible response. When enabled, Claude generates a chain-of-thought in a "thinking" block that is not shown to the user but informs the final answer.

## Enabling extended thinking

Add a `thinking` block to an agent's configuration in `config/dash.json`:

```json
{
  "agents": {
    "coder": {
      "model": "claude-sonnet-4-20250514",
      "systemPrompt": "You are a software engineering assistant.",
      "tools": ["bash", "read_file"],
      "maxTokens": 16000,
      "thinking": {
        "budgetTokens": 10000
      }
    }
  }
}
```

## Configuration

| Field | Type | Description |
|-------|------|-------------|
| `thinking.budgetTokens` | `number` | Maximum tokens the model can use for internal reasoning |

### Constraints

- `budgetTokens` must be **>= 1024**
- `budgetTokens` must be **< maxTokens** — the thinking budget is drawn from the total token budget
- When thinking is enabled, `temperature` is automatically omitted from the API request (Anthropic's API requires this)

## How it works

1. The agent sends the request with `thinking: { type: "enabled", budget_tokens: N }`
2. Claude generates thinking blocks internally
3. Thinking blocks are included in the streamed response as `thinking_delta` events
4. The final response contains both thinking blocks and the visible text response
5. Thinking blocks are preserved in the session for context continuity across rounds

### In the TUI

During the thinking phase, the spinner text changes to **"thinking deeply"** to indicate the model is reasoning. Once thinking completes, the visible response streams as normal.

Thinking blocks are not displayed to the user in the TUI — only the final text response is shown.

### In Telegram

Thinking happens server-side. The user only sees the final text response.

## Content blocks

When thinking is enabled, assistant messages contain `ContentBlock[]` instead of a plain string. The block types include:

- `thinking` — the model's internal reasoning (with a cryptographic `signature` for verification)
- `redacted_thinking` — thinking content that was redacted by the API (opaque `data` field)
- `text` — the visible response text
- `tool_use` — tool calls (thinking can precede tool use)

These blocks are preserved in session JSONL entries so that thinking context carries across multi-turn conversations.

## When to use it

**Good candidates for extended thinking:**
- Complex coding tasks (debugging, architecture decisions)
- Multi-step reasoning problems
- Tasks requiring careful analysis before action

**Skip extended thinking for:**
- Simple Q&A or factual lookups
- Short responses where reasoning overhead isn't worth the latency
- High-throughput use cases where speed matters more than depth

## Budget tuning

The `budgetTokens` value controls how much reasoning the model can do. Higher budgets allow deeper thinking but increase latency and cost.

| Budget | Use case |
|--------|----------|
| 1024–4000 | Light reasoning, quick analysis |
| 4000–10000 | Moderate complexity, code review |
| 10000–30000 | Deep analysis, complex debugging |

The model may use fewer tokens than the budget — it stops thinking when it has enough context to respond. The budget is a ceiling, not a target.
