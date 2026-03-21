# Mission Control Visual Redesign — Design Spec

## Overview

Update the Mission Control Electron app's visual design to match the Pencil designs in `designs/dash.pen`. This is a **purely visual/styling update** — no functionality, routing, state management, or business logic changes.

## Goals

1. Replace the blue (#3b82f6) primary with brand orange (#FF5500) across all screens
2. Switch from system fonts to Outfit + JetBrains Mono (matching the brand identity)
3. Redesign the Sidebar with grouped navigation sections
4. Update all screen layouts to match their Pencil design counterparts
5. Introduce the MC design token system from Pencil's variables

## Non-Goals

- Adding new features or screens
- Changing routing, state management, or IPC
- Adding shadcn/ui or any component library
- Changing the Electron/Vite build pipeline

---

## Design Token System

Replace the current `main.css` `@theme` block with the full MC token set from the Pencil variables:

```css
@theme {
  /* Core */
  --color-background: #0a0a0a;
  --color-foreground: #fafafa;
  --color-surface: #0f0f0f;
  --color-border: #262626;
  --color-muted: #a3a3a3;

  /* Brand */
  --color-primary: #FF5500;
  --color-primary-hover: #CC4400;
  --color-accent: #FF5500;
  --color-accent-tint: #FF550018;

  /* Cards */
  --color-card-bg: #141414;
  --color-card-hover: #1c1c1c;

  /* Sidebar */
  --color-sidebar-bg: #111111;
  --color-sidebar-hover: #1a1a1a;
  --color-sidebar-active: #222222;

  /* Status */
  --color-green: #00CC66;
  --color-green-tint: #16a34a18;
  --color-red: #f87171;
  --color-red-tint: #ef444418;
  --color-yellow: #facc15;
  --color-yellow-tint: #facc1518;

  /* Fonts */
  --font-display: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}
```

Add Google Fonts import at the top of `main.css`:
```css
@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');
```

### Typography Rules

| Role | Font | Weight | Size | Tracking | Notes |
|------|------|--------|------|----------|-------|
| Page title | Outfit | 600 | 22px | — | `text-foreground` |
| Section label | JetBrains Mono | 600 | 11px | +2px | ALL CAPS, `text-accent` |
| Nav item | Outfit | 500 | 14px | — | `text-muted`, active: `text-foreground` 600 |
| Nav section label | JetBrains Mono | 600 | 9px | +3px | ALL CAPS, `text-accent` |
| Body text | Outfit | 400 | 14px | — | `text-foreground` |
| Muted text | Outfit | 400 | 13px | — | `text-muted` |
| Mono detail | JetBrains Mono | 400 | 12px | — | Code, keys, metadata |
| Button text | Outfit | 600 | 13px | — | White on accent bg |

---

## Sidebar (`Sidebar.tsx`)

Complete rewrite matching Pencil component `F2CO3`.

**Structure:**
```
Sidebar (w-56, bg-sidebar-bg, border-r border-border, flex flex-col, p-3.5)
├── Header (flex justify-between items-center, px-1, pt-3 pb-4, border-b border-border)
│   ├── Logo Group (flex items-center gap-2)
│   │   ├── Zap icon (18px, text-accent)
│   │   └── "Mission Control" (Outfit 700, 13px, tracking-wide, text-foreground)
│   └── Health dot (8px circle, green/red)
├── Nav (flex flex-col gap-0.5, py-2)
│   ├── Section: "CORE" label
│   │   ├── NavItem: Dashboard (LayoutDashboard)
│   │   └── NavItem: Chat (MessageCircle)
│   ├── Section: "MANAGE" label (pt-4)
│   │   ├── NavItem: Agents (Bot)
│   │   └── NavItem: Messaging Apps (MessageSquare)
│   └── Section: "CONFIGURE" label (pt-4)
│       ├── NavItem: AI Providers (Plug)
│       ├── NavItem: Secrets (KeyRound)
│       └── NavItem: Settings (Settings)
├── Spacer (flex-1)
└── Footer (flex items-center gap-2, px-3, py-3)
    ├── LifeBuoy icon (14px, text-muted)
    └── "Feedback" (JetBrains Mono 11px, text-muted)
```

**Section labels:** `font-mono text-[9px] font-semibold uppercase tracking-[3px] text-accent px-3 py-1.5`

**NavItem:**
- Default: `flex items-center gap-2.5 h-9 px-3 rounded-none text-muted hover:bg-sidebar-hover hover:text-foreground`
- Active: `bg-sidebar-active text-foreground font-semibold border-l-[3px] border-accent`
- Icon: 16px, inherits text color

---

## Screen Layouts

### Shared Page Header Pattern

Every screen has a consistent header bar:
```
Header (flex justify-between items-center, bg-surface, px-8 py-6, border-b border-border)
├── Title (Outfit 600, 22px, text-foreground)
└── Actions (flex gap-3)
    └── Primary button (bg-accent, text-white, px-5 py-2.5, flex items-center gap-2)
```

### Dashboard (`routes/index.tsx`)

Matches Pencil frame `sRJow`.

**Layout:**
```
Main Content (flex-1 flex flex-col)
├── Header: "Dashboard" + "Deploy Agent" button
└── Body (flex flex-col gap-6, p-8, overflow-y-auto)
    ├── Section label: "OVERVIEW"
    ├── Stat Cards (flex gap-4)
    │   ├── Card: Active Agents (value + "→ N total" delta)
    │   ├── Card: Conversations Today (value + delta)
    │   ├── Card: Messages Processed (value, formatted with k suffix + delta)
    │   └── Card: Avg Response Time (value + "s" suffix + delta)
    └── Two Columns (flex gap-4, flex-1)
        ├── Recent Conversations (flex-1, card)
        │   ├── Card header: "RECENT CONVERSATIONS" + "View All →"
        │   └── Table: Agent, Channel, Last Message, Time
        └── System Health (w-80, card)
            ├── Card header: "SYSTEM HEALTH"
            ├── Services: Chat API, Gateway, Management API (dot + name + status text)
            ├── Divider
            ├── "AGENTS" sub-label
            └── Agent list: dot + name + status badge
```

**Stat Card:**
- `bg-card-bg border border-border p-5 flex-1 flex flex-col gap-3`
- Label: `font-mono text-[10px] uppercase tracking-wider text-muted`
- Value: `font-display text-3xl font-bold text-foreground`
- Delta: `text-xs flex items-center gap-1` — green for positive, red for negative

**Status dots**: Same as HealthDot component but use new token colors.

### Chat (`routes/chat.tsx`)

Matches Pencil frame `39swp`. Major layout change to 3-column.

**Layout:**
```
Main Content (flex-1 flex flex-col)
├── Header: "Chat" + filter dropdowns (All Agents, All Channels)
└── Chat Body (flex, flex-1)
    ├── Conversation List (w-[300px], bg-surface, border-r border-border)
    │   ├── Search bar (px-4 py-3, border-b)
    │   └── Conversation items (scrollable)
    │       └── Each: agent name + channel badge + last message preview + time
    │           Active: bg-card-bg, left-3px accent border
    └── Chat Panel (flex-1, flex flex-col)
        ├── Chat sub-header: agent name + "via Channel" + status
        ├── Messages area (flex-1, p-6, overflow-y-auto)
        │   ├── Agent messages: bg-card-bg, rounded-lg, p-4, text-foreground
        │   └── User messages: bg-accent, rounded-lg, p-4, text-white
        └── Input bar (bg-surface, border-t, px-6 py-4)
            ├── Text input (flex-1, bg-card-bg, border, rounded-lg, px-4 py-3)
            └── Send button (bg-accent, rounded-lg, p-2.5)
```

**Conversation list item:**
- Default: `px-4 py-3.5 border-b border-border hover:bg-sidebar-hover cursor-pointer`
- Active: `bg-card-bg border-l-[3px] border-accent`
- Agent name: `font-display text-sm font-semibold text-foreground`
- Channel: `font-mono text-[10px] text-accent`
- Preview: `text-xs text-muted truncate`
- Time: `text-[10px] text-muted`

**User messages** in accent orange (`bg-accent text-white`) is the signature brand styling change.

### Agents List (`routes/agents/index.tsx`)

Matches Pencil frame `eNbKe`.

**Layout:**
```
Main Content (flex-1 flex flex-col)
├── Header: "Agents" + search input (w-56) + "Deploy Agent" button
└── Body (flex flex-col gap-4, p-8)
    ├── Section label: "DEPLOYED AGENTS"
    └── Table (bg-card-bg, border border-border)
        ├── Header row (bg-surface, border-b)
        │   └── Columns: STATUS, NAME, MODEL, TOOLS, CHANNELS, LAST ACTIVE
        └── Data rows (border-b border-border, hover:bg-card-hover)
            ├── Status: colored dot (green/yellow/red)
            ├── Name: font-display font-semibold text-foreground
            ├── Model: font-mono text-xs text-muted
            ├── Tools: count badge (bg-accent-tint text-accent)
            ├── Channels: count badge (bg-accent-tint text-accent)
            └── Last Active: text-xs text-muted
```

**Table styling:**
- Header cells: `font-mono text-[10px] uppercase tracking-wider text-muted px-5 py-3`
- Data cells: `px-5 py-3.5 text-sm`
- Rows: `border-b border-border hover:bg-card-hover cursor-pointer`

### Agent Detail (`routes/agents/$id.tsx`)

Matches Pencil frame `WR8rk`.

**Layout:**
```
Main Content (flex-1 flex flex-col)
├── Header: back arrow + agent name + status badge
├── Tab Bar (bg-surface, border-b, px-8)
│   └── Tabs: Overview, Configuration, Channels, Logs
│       Active: text-foreground font-semibold, border-b-2 border-accent
│       Inactive: text-muted font-medium
└── Tab Content (flex-1, p-8)
```

**Overview tab:**
```
Two columns (flex gap-6)
├── Left (w-[360px], flex flex-col gap-5)
│   ├── Agent Info card (bg-card-bg, border)
│   │   ├── Card header: "AGENT INFO" label
│   │   └── Key-value rows: Model, Created, Last Active, Status
│   └── Connected Channels card
│       ├── Card header: "CONNECTED CHANNELS" label
│       └── Channel rows: icon + name + status badge
└── Right (flex-1)
    └── Recent Activity card (bg-card-bg, border)
        ├── Card header: "RECENT ACTIVITY"
        └── Timeline events: timestamp + icon + description
```

**Configuration tab:** Keep existing ModelChainEditor, system prompt textarea, tools selector — restyle with new tokens (card-bg backgrounds, accent buttons, mono labels).

**Logs tab:** Keep existing log viewer — restyle with new tokens.

**Tab mapping to existing code:**
- The current code has 3 tabs: Configuration, Skills, Monitor
- Pencil has 4 tabs: Overview, Configuration, Channels, Logs
- **Overview** = new tab (agent info + connected channels + activity timeline)
- **Configuration** = existing AgentConfigTab (restyled)
- **Channels** = extract channel connections from existing code into its own tab
- **Logs** = existing AgentMonitorTab (restyled, renamed)
- **Skills** tab is removed (tools are shown in Configuration)

### Messaging Apps (`routes/messaging-apps/index.tsx`)

Matches Pencil frame `43qsK`.

**Layout:**
```
Main Content (flex-1 flex flex-col)
├── Header: "Messaging Apps" + "Connect App" button
└── Body (p-8)
    ├── Section label: "CONNECTED PLATFORMS"
    └── Grid (grid grid-cols-2 gap-4)
        └── Platform cards:
            ├── Icon (colored, 24px) + Name (Outfit 600, 16px) + Status badge
            ├── "N agents connected" (text-xs text-muted)
            └── "Configure →" link (text-accent text-xs)
```

**Platform card:**
- `bg-card-bg border border-border p-5 flex flex-col gap-3 hover:bg-card-hover`
- Header row: icon + name + status badge (right-aligned)
- Status badge: `rounded px-2 py-0.5 text-[10px] font-mono font-semibold`
  - Connected: `bg-green-tint text-green`
  - Not Connected: `bg-red-tint text-red`

### Messaging App Detail (`routes/messaging-apps/$id.tsx`)

Matches Pencil frame `fglbc`.

**Layout:**
```
Main Content (flex-1 flex flex-col)
├── Header: platform icon + "Platform — Workspace Name" + status badge
└── Body (p-8, flex gap-6)
    ├── Left (flex-1)
    │   └── Connection Details card
    │       ├── "CONNECTION DETAILS" label
    │       └── Key-value rows: Platform, Workspace, Bot Token (masked), Connected Since, Messages Today
    │       └── Actions: "Disconnect" (outline) + "Edit Connection" (accent)
    └── Right (w-[360px], flex flex-col gap-5)
        ├── Connected Agents card (green-tinted header)
        │   └── Agent rows: dot + name + model + status
        └── Recent Events card
            └── Timeline: timestamp + event description
```

### AI Providers (`routes/connections.tsx`)

Matches Pencil frame `jyOPa`.

**Layout:**
```
Main Content (flex-1 flex flex-col)
├── Header: "AI Providers" + subtitle + "Add Provider" button
└── Body (p-8)
    ├── Section label: "CONFIGURED PROVIDERS"
    └── Provider list (flex flex-col gap-3)
        └── Provider row (bg-card-bg border border-border px-5 py-4 flex items-center)
            ├── Provider icon (colored circle, 36px)
            ├── Info: name (font-semibold) + models (font-mono text-xs text-muted)
            ├── Status badge (Active green / Disabled red)
            └── Actions: edit + delete icon buttons
```

### Secrets (`routes/secrets.tsx`)

Matches Pencil frame `ZjLwN`.

**Layout:**
```
Main Content (flex-1 flex flex-col)
├── Header: "Secrets" + subtitle + "Add Secret" button
└── Body (p-8)
    ├── Info banner (bg-accent-tint border border-accent/30 rounded px-4 py-3)
    │   └── Shield icon + "Secrets are encrypted with AES-256-GCM..." text
    └── Table (bg-card-bg border border-border)
        ├── Header: KEY, VALUE, UPDATED, ACTIONS
        └── Rows:
            ├── Key: font-mono text-sm text-foreground uppercase
            ├── Value: font-mono text-sm text-muted (masked: ••• •••• ••••)
            ├── Updated: text-xs text-muted
            └── Actions: edit + copy + delete icon buttons
```

### Settings (`routes/settings.tsx`)

Keep existing layout. Restyle with:
- New font tokens (Outfit for body, JetBrains Mono for labels)
- Accent color for buttons/interactive elements
- Card-bg for input/select backgrounds
- Section labels in mono uppercase brand orange

### Deploy (`routes/deploy.tsx`)

Keep existing wizard flow. Restyle with:
- Accent color for progress/active states
- Card-bg for form backgrounds
- Brand-styled buttons and inputs
- Section labels in mono uppercase

### Setup Wizard (`SetupWizard.tsx`)

Keep existing multi-step flow. Restyle with:
- Brand logo (Zap icon) in header
- Accent color for progress indicators
- Card-bg for step content areas
- Brand-styled buttons

---

## Shared Component Changes

### HealthDot.tsx
- Update colors: connected → `bg-green`, connecting → `bg-yellow animate-pulse`, disconnected → `bg-red`
- No structural changes

### Markdown.tsx
- No changes needed (code highlighting theme is fine)

### ModelChainEditor.tsx
- Restyle dropdowns/buttons with new tokens
- Accent color for add/remove actions

### ToolResult.tsx
- No changes needed (renders inside chat messages)

---

## Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `src/renderer/src/assets/main.css` | Modify | Replace theme tokens, add font imports |
| `src/renderer/src/components/Sidebar.tsx` | Rewrite | Grouped nav with section labels |
| `src/renderer/src/routes/index.tsx` | Rewrite | Dashboard with stats, conversations, health |
| `src/renderer/src/routes/chat.tsx` | Major modify | Add conversation list panel, restyle messages |
| `src/renderer/src/routes/agents/index.tsx` | Major modify | Table layout with columns |
| `src/renderer/src/routes/agents/$id.tsx` | Major modify | Tab bar, overview tab, restyle existing tabs |
| `src/renderer/src/routes/agents/-components/AgentConfigTab.tsx` | Modify | Restyle with new tokens |
| `src/renderer/src/routes/agents/-components/AgentMonitorTab.tsx` | Modify | Rename to Logs, restyle |
| `src/renderer/src/routes/agents/-components/AgentSkillsTab.tsx` | Delete | Merged into Configuration |
| `src/renderer/src/routes/messaging-apps/index.tsx` | Modify | Card grid layout |
| `src/renderer/src/routes/messaging-apps/$id.tsx` | Modify | Two-column detail layout |
| `src/renderer/src/routes/connections.tsx` | Modify | Provider list with icons/badges |
| `src/renderer/src/routes/secrets.tsx` | Modify | Table layout with info banner |
| `src/renderer/src/routes/settings.tsx` | Modify | Restyle with new tokens |
| `src/renderer/src/routes/deploy.tsx` | Modify | Restyle with new tokens |
| `src/renderer/src/components/SetupWizard.tsx` | Modify | Restyle with new tokens |
| `src/renderer/src/components/HealthDot.tsx` | Modify | Update colors |
| `src/renderer/src/components/ModelChainEditor.tsx` | Modify | Restyle with new tokens |

---

## Brand Rules

1. **Primary accent** is always `#FF5500` — never blue
2. **Section labels** precede every content group: JetBrains Mono 600, 9-11px, ALL CAPS, wide tracking, accent color
3. **Cards** use `bg-card-bg border border-border` — no shadows, no rounded corners beyond default
4. **Active sidebar item** has left 3px accent border + active bg
5. **User chat messages** use accent orange background (signature brand styling)
6. **Fonts**: Outfit for everything users read, JetBrains Mono for labels, metadata, code, keys
7. **Status colors**: green `#00CC66`, red `#f87171`, yellow `#facc15` — with tinted backgrounds for badges
