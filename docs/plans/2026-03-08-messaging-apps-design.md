# Messaging Apps — Design

**Date:** 2026-03-08
**Status:** Approved

## Overview

Allow non-technical users to manage "Messaging Apps" (formerly "channels") in Mission Control. Users can connect external messaging platforms (starting with Telegram) to their AI agents, with flexible routing rules and security controls.

The feature has two modes:
- **Simple mode** — connect one messaging app to one agent in a guided wizard
- **Advanced mode** — multiple routing rules with conditions, allow/deny lists per rule

---

## Naming

| Old term | New term |
|----------|----------|
| Channel | Messaging App |
| Channel adapter | Messaging App connection |
| Channel routing | Routing Rules |

The sidebar entry is **"Messaging Apps"**, sitting between Agents and Secrets in the nav.

---

## Data Architecture

### `MessagingApp` entity

Stored globally in `~/.mission-control/messaging-apps.json` via a new `MessagingAppRegistry`.

```typescript
interface MessagingApp {
  id: string
  name: string                  // User-given, e.g. "Family Group Bot"
  type: 'telegram'              // | 'whatsapp' | 'slack' (future)
  credentialsKey: string        // Key into EncryptedSecretStore
  enabled: boolean
  createdAt: string
  globalDenyList: string[]      // Always blocked before routing evaluates
  routing: RoutingRule[]        // Ordered — first match wins
}

interface RoutingRule {
  id: string
  label?: string                // e.g. "Tech Support Group", "VIP Clients"
  condition: RoutingCondition
  targetDeploymentId: string
  targetAgentName: string
  allowList: string[]           // Empty = allow all who pass the condition
  denyList: string[]            // Block specific senders from this agent
}

type RoutingCondition =
  | { type: 'default' }                   // Catch-all fallback
  | { type: 'sender'; ids: string[] }     // Match specific sender IDs
  | { type: 'group'; ids: string[] }      // Match specific group/chat IDs
```

Credentials (bot tokens etc.) are stored in the existing `EncryptedSecretStore` using the key pattern `messaging-app:{id}:token`.

### Security Evaluation Order

For each incoming message:

1. Check `globalDenyList` → reject if sender is listed
2. Walk `routing[]` in order — first rule whose `condition` matches wins
3. Within the matched rule: check `denyList` → reject if matched; check `allowList` → reject if not present (when list is non-empty)
4. Route message to the rule's `targetDeploymentId` / `targetAgentName`

**Simple path:** a single `{ type: 'default' }` rule pointing to one agent. No complexity exposed in the UI.

---

## Telegram Setup Wizard

A 10-step guided wizard, one screen per step, with large friendly text and inline screenshots. Designed for non-technical users who may never have used Telegram.

| Step | Content |
|------|---------|
| 1. **What is Telegram?** | "Telegram is a free messaging app, like WhatsApp. Your AI assistant can receive messages through it." + download link |
| 2. **Do you have Telegram?** | Yes/No branch — No → shows App Store / Google Play / Desktop download links |
| 3. **What is a Bot?** | "A Bot is a special account your assistant uses to receive messages. Think of it like a virtual phone number." |
| 4. **Open BotFather** | Screenshot: "In Telegram, search for **@BotFather** — it's Telegram's official tool for creating bots. Tap the blue **START** button." |
| 5. **Create your bot** | "Type `/newbot` and send it. BotFather asks for a name (what people see) then a username (must end in `bot`)." |
| 6. **Copy your token** | Screenshot highlighting the token. "BotFather gives you a long code — your **bot token**. It looks like `110201543:AAHdqTcvCH...`. Copy it carefully." |
| 7. **Paste token** | Input field + Verify button — calls Telegram API to confirm the token is valid, shows bot username and name on success |
| 8. **Name this connection** | "Give this a friendly name so you remember it, like **'My Customer Support Bot'**" |
| 9. **Choose assistant** | Dropdown of all agents across all active deployments. **Simple default:** first agent selected. **Advanced toggle** reveals routing rules panel. |
| 10. **Done!** | "Your Telegram bot **@yourbotname** is connected! Share this link: `t.me/yourbotname`" + QR code |

---

## Global "Messaging Apps" Page

### Main page — card grid

Each card shows:
- Platform icon (Telegram logo, etc.)
- User-given name + bot username
- Status pill: `Connected` / `Disconnected` / `Error`
- Agents it routes to (e.g. "→ Support Bot, Sales Bot")
- Enable/Disable toggle
- Click → detail page

### Detail page — two tabs

**Tab 1: Overview**
- Bot info (name, username, platform)
- Enable/disable toggle
- Global Block List — text input for sender IDs always blocked regardless of routing

**Tab 2: Routing Rules**
- Ordered list of rules (drag to reorder priority)
- Each rule card: condition summary, target agent, allow/deny counts
- "Add Rule" → slide-out panel:
  - Condition selector: `Default (everyone)` / `Specific people` / `Specific groups`
  - For specific conditions: ID inputs with help text ("Where do I find a Telegram ID? [?]")
  - Target agent: dropdown grouped by deployment
  - Allow list (optional, expandable)
  - Deny list (optional, expandable)
- **"Quick setup" banner** for simple-mode apps: "All messages go to [Agent X]. [Switch to advanced routing →]"

### Agent detail page (existing)

New "Messaging Apps" section — lists which apps route to this agent, with links to each app's detail page.

---

## Backend Architecture

### New: `packages/mc/src/messaging-apps.ts`

`MessagingAppRegistry` — mirrors `AgentRegistry` pattern:
- `create()`, `update()`, `delete()`, `list()`, `get()`
- Persists to `~/.mission-control/messaging-apps.json`
- Token storage delegated to `EncryptedSecretStore`

### New IPC handlers (`apps/mission-control/src/main/ipc.ts`)

```
messagingApps:list
messagingApps:create
messagingApps:update
messagingApps:delete
messagingApps:verifyTelegramToken    ← validates token via Telegram Bot API, returns bot info
```

### Runtime integration (`packages/mc/src/runtime/process.ts`)

`buildGatewayConfig()` extended to:
1. Read all `MessagingApp` records
2. Filter to those with routing rules targeting the current deployment
3. Inject them as channel entries in the gateway config with full routing data

### Routing logic (`packages/channels/src/router.ts`)

`MessageRouter` gains ordered rule evaluation:
- Walk rules in order, evaluate condition against incoming message
- Check allow/deny lists on the matched rule
- Return the matching `AgentClient` or null (message silently dropped)
- Backwards compatible — existing single-agent setups continue to work via a default rule

---

## Backwards Compatibility

No breaking changes. The existing `channel → agentName` binding in deployed gateway configs maps exactly to a single `{ type: 'default' }` routing rule. Existing deployments continue working without modification.

---

## Future Platforms

The `type` field on `MessagingApp` is extensible. Adding WhatsApp or Slack means:
1. A new `ChannelAdapter` implementation in `packages/channels/`
2. A new setup wizard for that platform (Steps 1–10 tailored to that platform's auth flow)
3. The routing and security model is shared — no changes needed

---

## Out of Scope

- Keyword-based or content-based routing conditions (can be added later)
- Two-way routing (agent initiating contact, not just receiving)
- Cloud/hosted messaging app management (local only for now)
