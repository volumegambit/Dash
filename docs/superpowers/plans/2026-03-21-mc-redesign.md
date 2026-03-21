# Mission Control Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update Mission Control's visual design to match the Pencil designs — brand orange, Outfit + JetBrains Mono fonts, grouped sidebar, and redesigned layouts for all screens.

**Architecture:** Purely visual/styling changes across 22 files in `apps/mission-control/`. No functionality, routing, state management, or business logic changes. Theme tokens updated first, then sidebar, then screens from most-impacted to least-impacted.

**Tech Stack:** Electron 33, React 19, Tailwind CSS v4, TanStack Router, Zustand, Lucide React

---

## File Map

All paths relative to `apps/mission-control/`.

| File | Action | Task |
|------|--------|------|
| `src/renderer/src/assets/main.css` | Modify | 1 |
| `src/renderer/src/routes/__root.tsx` | Modify | 1 |
| `src/renderer/src/components/Sidebar.tsx` | Rewrite | 2 |
| `src/renderer/src/components/HealthDot.tsx` | Modify | 2 |
| `src/renderer/src/routes/index.tsx` | Rewrite | 3 |
| `src/renderer/src/routes/chat.tsx` | Major modify | 4 |
| `src/renderer/src/routes/agents/index.tsx` | Major modify | 5 |
| `src/renderer/src/routes/agents/$id.tsx` | Major modify | 6 |
| `src/renderer/src/routes/agents/-components/AgentConfigTab.tsx` | Modify | 6 |
| `src/renderer/src/routes/agents/-components/AgentMonitorTab.tsx` | Modify | 6 |
| `src/renderer/src/routes/agents/-components/AgentSkillsTab.tsx` | Delete | 6 |
| `src/renderer/src/routes/messaging-apps/index.tsx` | Modify | 7 |
| `src/renderer/src/routes/messaging-apps/$id.tsx` | Modify | 7 |
| `src/renderer/src/routes/messaging-apps/new-telegram.tsx` | Modify | 7 |
| `src/renderer/src/routes/messaging-apps/new-whatsapp.tsx` | Modify | 7 |
| `src/renderer/src/routes/connections.tsx` | Modify | 8 |
| `src/renderer/src/components/ProviderConnectModal.tsx` | Modify | 8 |
| `src/renderer/src/routes/secrets.tsx` | Modify | 9 |
| `src/renderer/src/routes/settings.tsx` | Modify | 9 |
| `src/renderer/src/routes/deploy.tsx` | Modify | 9 |
| `src/renderer/src/components/SetupWizard.tsx` | Modify | 9 |
| `src/renderer/src/components/ModelChainEditor.tsx` | Modify | 9 |

---

## Task 1: Foundation — Theme tokens, fonts, root layout

**Files:**
- Modify: `apps/mission-control/src/renderer/src/assets/main.css`
- Modify: `apps/mission-control/src/renderer/src/routes/__root.tsx`

- [ ] **Step 1: Update main.css**

Replace the entire `main.css` with the new theme tokens and font imports. Read the current file first, then replace:

- Add `@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');` at the top
- Replace the `@theme` block with the full MC token set from the spec (Core, Brand, Cards, Sidebar, Status, Fonts tokens)
- Update the `body` rule to use `font-family: var(--font-display)` instead of the system font stack
- Keep any other existing CSS rules (scrollbar styling, etc.)

- [ ] **Step 2: Update root layout**

Read `__root.tsx` and find the main content wrapper with `p-8`. Remove the `p-8` class so it becomes `flex flex-1 flex-col overflow-auto` (no padding). Each screen will now control its own padding.

Also update any font-related classes on the outer container to use `font-display` if there's a font-family class.

- [ ] **Step 3: Verify the app compiles**

```bash
cd apps/mission-control && npm run dev
```

The app should compile and show the existing screens with the new colors (orange instead of blue) but layout may be slightly off due to removed padding. This is expected — subsequent tasks fix each screen.

- [ ] **Step 4: Commit**

```bash
git add apps/mission-control/src/renderer/src/assets/main.css apps/mission-control/src/renderer/src/routes/__root.tsx
git commit -m "feat(mc): update theme tokens to brand orange, add Outfit + JetBrains Mono fonts"
```

---

## Task 2: Sidebar + HealthDot

**Files:**
- Rewrite: `apps/mission-control/src/renderer/src/components/Sidebar.tsx`
- Modify: `apps/mission-control/src/renderer/src/components/HealthDot.tsx`

- [ ] **Step 1: Read existing Sidebar.tsx and HealthDot.tsx**

Read both files to understand the current implementation — nav items array, Link component usage, health indicators, router patterns.

- [ ] **Step 2: Rewrite Sidebar.tsx**

Completely replace with the new grouped navigation design:

- Header: Zap icon (lucide, 18px, `text-accent`) + "Mission Control" (Outfit 700, 13px, `tracking-wide text-foreground`) + gateway health dot
- Grouped nav sections with section labels in `font-mono text-[9px] font-semibold uppercase tracking-[3px] text-accent px-3 py-1.5`:
  - **CORE**: Dashboard (LayoutDashboard), Chat (MessageCircle)
  - **MANAGE**: Agents (Bot), Messaging Apps (MessageSquare)
  - **CONFIGURE**: AI Providers (Plug), Secrets (KeyRound), Settings (Settings)
- Nav items use TanStack Router's `Link` component with:
  - Default: `flex items-center gap-2.5 h-9 px-3 text-muted hover:bg-sidebar-hover hover:text-foreground transition-colors`
  - Active: `bg-sidebar-active text-foreground font-semibold border-l-[3px] border-accent` (use `activeProps` or `[&.active]` pattern from TanStack Router)
  - Icons: 16px, inherit color
- Keep existing health dot indicators on agents and messaging-apps routes
- Footer: LifeBuoy icon (14px) + "Feedback" link (JetBrains Mono 11px, text-muted)
- Outer container: `w-56 bg-sidebar-bg border-r border-border flex flex-col p-3.5 h-full`

- [ ] **Step 3: Update HealthDot.tsx**

Update the color classes:
- connected: `bg-green` (was green-400)
- connecting: `bg-yellow animate-pulse` (was yellow-400)
- disconnected: `bg-red` (was red-400)

Keep the existing size (1.5x1.5 or 2x2 depending on current) and structure.

- [ ] **Step 4: Verify sidebar renders correctly**

Start the dev server, check sidebar has grouped sections, brand orange accent, correct active states.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control/src/renderer/src/components/Sidebar.tsx apps/mission-control/src/renderer/src/components/HealthDot.tsx
git commit -m "feat(mc): redesign sidebar with grouped nav sections and brand styling"
```

---

## Task 3: Dashboard

**Files:**
- Rewrite: `apps/mission-control/src/renderer/src/routes/index.tsx`

- [ ] **Step 1: Read current index.tsx**

Read the existing dashboard to understand what data it displays and how it fetches deployment data (Zustand store, IPC calls).

- [ ] **Step 2: Rewrite the dashboard**

Rebuild the layout to match the Pencil design:

**Page header**: `bg-surface px-8 py-6 border-b border-border flex justify-between items-center`
- Title: "Dashboard" (Outfit 600, 22px, text-foreground)
- "Deploy Agent" button: `bg-accent text-white px-5 py-2.5 flex items-center gap-2 font-semibold text-[13px]` with Plus icon + Link to /deploy

**Body**: `flex flex-col gap-6 p-8 overflow-y-auto flex-1`
- Section label "OVERVIEW": `font-mono text-[11px] font-semibold uppercase tracking-[2px] text-accent`
- **4 stat cards** in a flex row gap-4:
  - Each: `bg-card-bg border border-border p-5 flex-1 flex flex-col gap-3`
  - Label: `font-mono text-[10px] uppercase tracking-wider text-muted`
  - Value: `font-display text-3xl font-bold text-foreground`
  - Delta: `text-xs flex items-center gap-1` with colored indicator
  - Cards: "Active Agents" (count from deployments), "Conversations Today", "Messages Processed", "Avg Response Time"
  - For data not available from stores, show placeholder values (0, "—") — this is a visual redesign, not adding analytics
- **Two columns** below: `flex gap-4 flex-1`
  - Left: "Recent Conversations" card (flex-1) with table header + rows showing recent deployment activity
  - Right: "System Health" panel (w-80) showing service status dots + agent status list

Preserve all existing data fetching (useDeployments store, IPC calls). Map existing data to the new layout. Where the Pencil design shows data the app doesn't currently have (conversations, message counts), show placeholder/computed values from what's available (e.g., deployment count as "active agents").

- [ ] **Step 3: Verify dashboard renders**

- [ ] **Step 4: Commit**

```bash
git add apps/mission-control/src/renderer/src/routes/index.tsx
git commit -m "feat(mc): redesign dashboard with stat cards, conversations, and health panel"
```

---

## Task 4: Chat

**Files:**
- Major modify: `apps/mission-control/src/renderer/src/routes/chat.tsx`

- [ ] **Step 1: Read current chat.tsx**

Read the full file — this is the most complex screen (~11KB+). Understand the message rendering, streaming, tool calls, file attachments, deployment selector, and chat store usage.

- [ ] **Step 2: Add conversation list panel and restyle**

This is the biggest layout change. Add a left-side conversation list panel and restyle all existing elements:

**Page header**: same shared pattern — "Chat" title + filter dropdowns (All Agents, All Channels) styled as `bg-card-bg border border-border px-3.5 py-2 text-sm text-muted`

**Chat body** becomes a 2-panel flex layout:
- **Left panel** (w-[300px], `bg-surface border-r border-border`):
  - Search bar at top: `px-4 py-3 border-b border-border` with search icon + input
  - Conversation items below (scrollable): derive from available deployments in the chat store
  - Each item: agent name + channel badge + last message preview + timestamp
  - Active item: `bg-card-bg border-l-[3px] border-accent`
- **Right panel** (flex-1): the existing chat UI, restyled:
  - Sub-header: agent name + "via Channel" info
  - Messages: user messages get `bg-accent text-white rounded-lg p-4`, agent messages get `bg-card-bg rounded-lg p-4`
  - Input bar: `bg-surface border-t border-border px-6 py-4` with input in `bg-card-bg border border-border rounded-lg`
  - Send button: `bg-accent text-white rounded-lg p-2.5`

**Keep all existing functionality**: streaming, thinking blocks, tool calls, tool results, file attachments, deployment selector logic. Only change the visual presentation.

Replace all blue color references (`text-primary`, `bg-primary`, `border-primary`, `text-blue-*`, `bg-blue-*`) with accent equivalents.

- [ ] **Step 3: Verify chat renders and functions**

Test: select a deployment, send a message, verify streaming works, verify tool calls render.

- [ ] **Step 4: Commit**

```bash
git add apps/mission-control/src/renderer/src/routes/chat.tsx
git commit -m "feat(mc): redesign chat with conversation list panel and brand styling"
```

---

## Task 5: Agents list

**Files:**
- Major modify: `apps/mission-control/src/renderer/src/routes/agents/index.tsx`

- [ ] **Step 1: Read current agents/index.tsx**

Understand current layout, deployment listing, status rendering, action buttons.

- [ ] **Step 2: Redesign to table layout**

Replace the current card/list layout with the Pencil table design:

**Page header**: "Agents" + search input (`w-56 bg-card-bg border border-border px-3.5 py-2 rounded-lg text-sm`) + "Deploy Agent" button

**Body**: `p-8 flex flex-col gap-4`
- Section label: "DEPLOYED AGENTS"
- Table container: `bg-card-bg border border-border overflow-hidden`
  - Header row: `bg-surface border-b border-border flex items-center px-5 py-3`
    - Columns: STATUS, NAME, MODEL, TOOLS, CHANNELS, LAST ACTIVE
    - Header text: `font-mono text-[10px] uppercase tracking-wider text-muted`
  - Data rows: `border-b border-border px-5 py-3.5 flex items-center hover:bg-card-hover cursor-pointer`
    - Click navigates to `/agents/$id`
    - Status: HealthDot component
    - Name: `font-display font-semibold text-foreground`
    - Model: `font-mono text-xs text-muted` (truncated model name)
    - Tools: count badge `bg-accent-tint text-accent text-xs px-2 py-0.5 rounded`
    - Channels: count badge (same style)
    - Last Active: `text-xs text-muted` (relative time)

Preserve existing action buttons (stop, remove) — move to row hover or keep inline.

- [ ] **Step 3: Verify**

- [ ] **Step 4: Commit**

```bash
git add apps/mission-control/src/renderer/src/routes/agents/index.tsx
git commit -m "feat(mc): redesign agents list with table layout"
```

---

## Task 6: Agent Detail — tabs, overview, restyle existing tabs

**Files:**
- Major modify: `apps/mission-control/src/renderer/src/routes/agents/$id.tsx`
- Modify: `apps/mission-control/src/renderer/src/routes/agents/-components/AgentConfigTab.tsx`
- Modify: `apps/mission-control/src/renderer/src/routes/agents/-components/AgentMonitorTab.tsx`
- Delete: `apps/mission-control/src/renderer/src/routes/agents/-components/AgentSkillsTab.tsx`

- [ ] **Step 1: Read all agent detail files**

Read `$id.tsx`, `AgentConfigTab.tsx`, `AgentMonitorTab.tsx`, `AgentSkillsTab.tsx` to understand current tab structure and data flow.

- [ ] **Step 2: Restructure tabs in $id.tsx**

Replace the current 3-tab layout with 4 tabs:

**Header**: `bg-surface px-8 py-4 border-b border-border flex items-center gap-4`
- Back arrow: ArrowLeft icon (20px, text-muted, cursor-pointer, navigates to /agents)
- Agent name: Outfit 600, 22px, text-foreground
- Status badge: `bg-green-tint text-green px-2.5 py-1 rounded text-xs font-semibold flex items-center gap-1.5` with green dot

**Tab bar**: `bg-surface px-8 border-b border-border flex`
- 4 tabs: Overview, Configuration, Channels, Logs
- Active: `text-foreground font-semibold border-b-2 border-accent px-5 py-3.5 text-[13px]`
- Inactive: `text-muted font-medium px-5 py-3.5 text-[13px] hover:text-foreground`
- Use local state to track active tab

**Tab content**: `flex-1 p-8 overflow-y-auto`

**Overview tab** (new): Two-column layout
- Left (w-[360px]): Agent Info card + Connected Channels card
  - Agent Info: key-value rows for Model, Created, Last Active, Status
  - Connected Channels: list of connected messaging apps with status
- Right (flex-1): Recent Activity card with timeline of events
  - Derive from deployment logs/events if available, or show placeholder

**Configuration tab**: Render existing AgentConfigTab (restyled)
**Channels tab**: Extract channel connections display into its own tab content
**Logs tab**: Render existing AgentMonitorTab (restyled, was "Monitor")

Remove the import and rendering of AgentSkillsTab.

- [ ] **Step 3: Restyle AgentConfigTab.tsx**

Replace blue references with accent. Update:
- Labels to `font-mono text-[11px] uppercase tracking-[2px] text-accent`
- Inputs/selects to `bg-card-bg border border-border`
- Buttons to `bg-accent text-white` or `border border-border text-muted` for secondary
- Card containers to `bg-card-bg border border-border p-5`

- [ ] **Step 4: Restyle AgentMonitorTab.tsx (rename concept to "Logs")**

Update visuals:
- Log container: `bg-card-bg border border-border`
- Log entries: `font-mono text-xs`
- Timestamps: `text-muted`
- Level badges: use status token colors (green/yellow/red)
- Filter controls: accent-styled

- [ ] **Step 5: Delete AgentSkillsTab.tsx**

```bash
rm apps/mission-control/src/renderer/src/routes/agents/-components/AgentSkillsTab.tsx
```

- [ ] **Step 6: Verify agent detail page**

Navigate to an agent detail, verify all 4 tabs render, switching works, existing functionality preserved.

- [ ] **Step 7: Commit**

```bash
git add apps/mission-control/src/renderer/src/routes/agents/
git commit -m "feat(mc): redesign agent detail with 4-tab layout and overview panel"
```

---

## Task 7: Messaging Apps (list + detail + creation forms)

**Files:**
- Modify: `apps/mission-control/src/renderer/src/routes/messaging-apps/index.tsx`
- Modify: `apps/mission-control/src/renderer/src/routes/messaging-apps/$id.tsx`
- Modify: `apps/mission-control/src/renderer/src/routes/messaging-apps/new-telegram.tsx`
- Modify: `apps/mission-control/src/renderer/src/routes/messaging-apps/new-whatsapp.tsx`

- [ ] **Step 1: Read all messaging-apps files**

Read all 4 files to understand current layout, store usage, and platform data.

- [ ] **Step 2: Redesign messaging-apps/index.tsx**

**Header**: "Messaging Apps" + "Connect App" button (accent)
**Body**: `p-8`
- Section label: "CONNECTED PLATFORMS"
- Grid: `grid grid-cols-2 gap-4`
- Each card: `bg-card-bg border border-border p-5 flex flex-col gap-3 hover:bg-card-hover`
  - Header row: platform icon (colored, from lucide — Hash for Slack, Send for Telegram, MessageCircle for WhatsApp) + name (Outfit 600, 16px) + status badge (right-aligned)
  - "N agents connected" (`text-xs text-muted`)
  - "Configure →" link (`text-accent text-xs hover:underline`)
- Status badges: Connected (`bg-green-tint text-green`), Not Connected (`bg-red-tint text-red`)

- [ ] **Step 3: Redesign messaging-apps/$id.tsx**

**Header**: platform icon + "Platform — Connection Name" + status badge
**Body**: `p-8 flex gap-6`
- Left (flex-1): Connection Details card with key-value rows + action buttons
- Right (w-[360px]): Connected Agents card + Recent Events card

Restyle all elements with new tokens. Keep existing functionality.

- [ ] **Step 4: Restyle new-telegram.tsx and new-whatsapp.tsx**

Update form styling: inputs → `bg-card-bg border border-border`, buttons → accent, labels → mono uppercase.

- [ ] **Step 5: Verify**

- [ ] **Step 6: Commit**

```bash
git add apps/mission-control/src/renderer/src/routes/messaging-apps/
git commit -m "feat(mc): redesign messaging apps with card grid and detail layout"
```

---

## Task 8: AI Providers + Provider Connect Modal

**Files:**
- Modify: `apps/mission-control/src/renderer/src/routes/connections.tsx`
- Modify: `apps/mission-control/src/renderer/src/components/ProviderConnectModal.tsx`

- [ ] **Step 1: Read both files**

- [ ] **Step 2: Redesign connections.tsx**

**Header**: "AI Providers" + subtitle "Configure API keys for LLM providers" + "Add Provider" button
**Body**: `p-8`
- Section label: "CONFIGURED PROVIDERS"
- Provider list: `flex flex-col gap-3`
- Each row: `bg-card-bg border border-border px-5 py-4 flex items-center gap-4 hover:bg-card-hover`
  - Provider name: `font-semibold text-foreground`
  - Models: `font-mono text-xs text-muted` (comma-separated)
  - Status badge: Active (`bg-green-tint text-green`) or Disabled (`bg-red-tint text-red`)
  - Action buttons: edit (Pencil icon) + delete (Trash2 icon), `text-muted hover:text-foreground`

- [ ] **Step 3: Restyle ProviderConnectModal.tsx**

Update modal overlay and content:
- Overlay: `bg-black/50` (keep)
- Modal content: `bg-background border border-border` (instead of bg-surface)
- Inputs: `bg-card-bg border border-border`
- Buttons: accent for primary, border-border for secondary
- Labels: mono uppercase where appropriate

- [ ] **Step 4: Verify**

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control/src/renderer/src/routes/connections.tsx apps/mission-control/src/renderer/src/components/ProviderConnectModal.tsx
git commit -m "feat(mc): redesign AI providers list and connect modal"
```

---

## Task 9: Secrets, Settings, Deploy, SetupWizard, ModelChainEditor

**Files:**
- Modify: `apps/mission-control/src/renderer/src/routes/secrets.tsx`
- Modify: `apps/mission-control/src/renderer/src/routes/settings.tsx`
- Modify: `apps/mission-control/src/renderer/src/routes/deploy.tsx`
- Modify: `apps/mission-control/src/renderer/src/components/SetupWizard.tsx`
- Modify: `apps/mission-control/src/renderer/src/components/ModelChainEditor.tsx`

- [ ] **Step 1: Read all 5 files**

- [ ] **Step 2: Redesign secrets.tsx**

**Header**: "Secrets" + subtitle "Encrypted key-value store for sensitive credentials" + "Add Secret" button
**Body**: `p-8`
- Info banner: `bg-accent-tint border border-accent/30 rounded px-4 py-3 flex items-center gap-3`
  - ShieldCheck icon (text-accent) + info text (text-sm text-muted)
- Table: `bg-card-bg border border-border mt-4`
  - Header: KEY, VALUE, UPDATED, ACTIONS (mono uppercase 10px)
  - Rows: key (mono text-sm), value (masked, mono text-muted), updated (text-xs text-muted), action icons (edit/copy/delete)

Keep the lock/unlock password screens — restyle with accent buttons and card-bg inputs.

- [ ] **Step 3: Restyle settings.tsx**

Add page header pattern. Restyle:
- Labels → mono uppercase accent
- Inputs/selects → bg-card-bg border border-border
- Buttons → accent for primary
- Section spacing → gap-6

- [ ] **Step 4: Restyle deploy.tsx**

Add page header pattern. Restyle the wizard:
- Step indicators → accent color for active
- Form fields → bg-card-bg border border-border
- Buttons → accent for primary, border-border for secondary
- Tool selection → accent-tint backgrounds for selected
- Section labels → mono uppercase

- [ ] **Step 5: Restyle SetupWizard.tsx**

- Accent color for progress dots/steps
- Brand logo: Zap icon in accent at top
- Input fields → bg-card-bg border border-border
- Primary buttons → bg-accent text-white

- [ ] **Step 6: Restyle ModelChainEditor.tsx**

- Dropdowns → bg-card-bg border border-border
- Add button → text-accent
- Remove buttons → text-red hover:text-red
- Labels → font-mono text-muted

- [ ] **Step 7: Verify all screens**

Navigate through Secrets, Settings, Deploy wizard, and trigger Setup Wizard if possible.

- [ ] **Step 8: Commit**

```bash
git add apps/mission-control/src/renderer/src/routes/secrets.tsx apps/mission-control/src/renderer/src/routes/settings.tsx apps/mission-control/src/renderer/src/routes/deploy.tsx apps/mission-control/src/renderer/src/components/SetupWizard.tsx apps/mission-control/src/renderer/src/components/ModelChainEditor.tsx
git commit -m "feat(mc): restyle secrets, settings, deploy, setup wizard with brand tokens"
```

---

## Task 10: Build verification + global sweep

**Files:**
- Potentially any file touched in Tasks 1-9

- [ ] **Step 1: Run TypeScript check**

```bash
cd apps/mission-control && npx tsc --noEmit
```

Fix any type errors.

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Fix any lint issues from the root.

- [ ] **Step 3: Run tests**

```bash
cd apps/mission-control && npm test
```

Fix any test failures caused by changed text/class names. Common fixes: update test assertions for "Send Feedback" → "Feedback", color class changes, removed components.

- [ ] **Step 4: Global sweep for remaining blue references**

Search for any remaining blue color references across all MC files:
- `text-blue` → replace with `text-accent` or `text-primary`
- `bg-blue` → replace with `bg-accent` or `bg-primary`
- `border-blue` → replace with `border-accent`
- `#3b82f6` → should not appear anywhere
- `#2563eb` → should not appear anywhere
- `text-primary` that still maps to blue → already fixed by token change, but verify

- [ ] **Step 5: Verify full app flow**

Start the app and navigate through every screen:
1. Dashboard — stats, health panel
2. Chat — conversation list, send message
3. Agents — table, click into detail
4. Agent Detail — all 4 tabs
5. Messaging Apps — grid, detail view
6. AI Providers — provider list
7. Secrets — table, lock/unlock
8. Settings — all controls
9. Deploy — wizard flow

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat(mc): final build verification and blue→orange color sweep"
```
