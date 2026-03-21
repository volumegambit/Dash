# Homepage & Waitlist API — Design Spec

## Overview

Rebuild the DashSquad homepage (`apps/website/`) from scratch to match the Pencil design (`designs/dash.pen`, frame `CYSJ3`), and add a new waitlist API (`apps/waitlist/`) to capture early access signups.

## Goals

1. Faithfully implement the Pencil homepage design with the DashSquad brand identity system
2. Establish a reusable component foundation via shadcn/ui with brand overrides
3. Capture early access email signups via a standalone API

## Non-Goals

- Dark/light mode toggle (fixed alternating sections per design)
- Pricing page or full marketing site
- Authentication or admin dashboard for the waitlist
- SEO optimization beyond basic meta tags (already in place)

---

## App 1: Homepage (`apps/website/`)

### Stack

- **Framework**: Next.js 15 (static export)
- **Styling**: Tailwind CSS v4 with `@theme` brand tokens
- **Components**: shadcn/ui with brand overrides (square corners, bold strokes, brand colors)
- **Fonts**: Outfit + JetBrains Mono via `next/font/google`
- **Icons**: Lucide React (already a dependency)

### Design Tokens (`globals.css`)

```css
@theme {
  --color-brand: #FF5500;
  --color-brand-dark: #CC4400;
  --color-command: #0A0A0A;
  --color-cream: #F5F2EB;
  --color-cream-border: #E0D8CC;
  --color-amber: #FFB800;
  --color-success: #00CC66;
  --color-surface: #141414;
  --color-surface-border: #222222;
  --color-text-primary: #FFFFFF;
  --color-text-secondary: #888888;
  --color-text-muted: #666666;
  --color-text-dark: #0A0A0A;
}
```

### Typography System

| Role | Font | Weight | Size | Tracking | Notes |
|------|------|--------|------|----------|-------|
| Hero headline | Outfit | 800 | 64px | -1px | line-height 1.1 |
| Section headline | Outfit | 800 | 48px | -2px | |
| Card title | Outfit | 800 | 22px | -1px | |
| Body text | Outfit | 400 | 15–19px | default | line-height 1.5–1.6 |
| Section label | JetBrains Mono | 600 | 11px | +3px | ALL CAPS, color: brand |
| Mono detail | JetBrains Mono | 400 | 11px | +1px | metadata, trust lines |

### shadcn/ui Configuration

Override defaults to match brand:
- **Border radius**: 0 on all functional elements (buttons, cards, inputs). Only exceptions: logo icon (rounded), pill badges (rounded-full), hero image (rounded-2xl)
- **Colors**: Map to brand tokens above
- **Components to install**: Button, Badge, Card, Input

### Page Structure (`page.tsx`)

```tsx
<main>
  <Nav />
  <Hero />
  <SecureSandbox />
  <DeployAndRun />
  <AIProviders />
  <MessagingApps />
  <UseCases />
  <HowItWorks />
  <FinalCTA />
  <Footer />
</main>
```

### Component Specs

#### 1. Nav
- **Background**: transparent over dark hero
- **Layout**: flex, space-between, padded 20px vertical / 80px horizontal
- **Left**: Logo icon (28px, rounded-md, brand bg, white chevron paths, orange glow shadow) + "dashsquad" wordmark (Outfit 800, 20px, white, -1px tracking)
- **Right**: "About" link, "Early Access" link (Outfit 400, 15px, #888), "Join the Alpha" pill button (rounded-full, brand bg, Outfit 600, 15px, white, padding 10/24)

#### 2. Hero
- **Background**: command (#0A0A0A)
- **Layout**: vertical, centered, gap 24px, padding 80px top / 120px sides / 60px bottom
- **Alpha badge**: pill (rounded-full), brand bg at 15% opacity, brand border 1px, brand dot (8px ellipse) + "Now in Alpha — Early Access Open" (Outfit 600, 13px, brand)
- **Headline**: "You bring the ambition.\nWe bring the squad." — Outfit 800, 64px, white, -1px tracking, 1.1 line-height, center, max-width 900px
- **Sub-copy**: description text — Outfit 400, 19px, #888, center, 1.6 line-height, max-width 750px
- **CTA button**: "Join the Alpha" — rounded-full, brand bg, Outfit 600, 18px, white, padding 16/40. Scrolls to FinalCTA email form.
- **Use-case pills**: 6 horizontal pills with wrap — each has: lucide icon (16px, brand color) + text (Outfit 500, 13px, white), rounded-full, bg #141414, border 1px #333, padding 6/14
  - "Research competitors" (search), "Draft blog posts" (file-text), "Summarize emails" (mail), "Analyze reports" (chart-bar), "Monitor trends" (trending-up), "Answer questions" (message-square)
- **Hero image**: `hero-squad.webp`, 900px wide, 500px tall, rounded-2xl, orange glow shadow, clip overflow

#### 3. SecureSandbox
- **Background**: cream (#F5F2EB)
- **Layout**: horizontal split (text left, visual right), gap 80px, padding 100px/160px
- **Left**: Section label "BUILT FOR TRUST" + headline "Runs on your machine.\nStays on your machine." (Outfit 800, 44px, dark, -1px tracking) + sub-copy (Outfit 400, 17px, #888) + 4 feature bullets with lucide icons
- **Right**: Sandbox visual (React component) — rounded-2xl card with white bg, subtle shadow, containing: lock icon row, divider, 3 agent status boxes, divider, footer status line
- **Feature bullets**: each has icon in cream circle (40px, rounded-lg) + title (Outfit 600, 16px, dark) + description (Outfit 400, 14px, #888, 1.5 line-height)
  - shield-check: "Sandboxed Execution" — "Each agent runs in an isolated environment with strict permission boundaries."
  - hard-drive: "100% Local Data" — "Conversations and session data stay on your computer. Nothing leaves without your explicit command."
  - file-search: "Full Audit Trail" — "Every action logged in append-only session files. See exactly what your agents did and why."
  - eye-off: "Zero Surveillance" — "No tracking, no ads, no data selling. Your conversations stay between you and your agents."

#### 4. DeployAndRun
- **Background**: command (#0A0A0A)
- **Layout**: vertical, gap 48px, padding 100px/160px
- **Content**: horizontal split — text left + MC deploy visual right
- **Left**: Section label "GETTING STARTED" + headline "Up and running in minutes" (Outfit 800, 48px, white) + sub-copy ("Deploy autonomous AI agents from Mission Control — no terminal needed. Configure, launch, and manage your entire squad from one dashboard.") + 3 bullet features:
  - mouse-pointer-click: "Point-and-click deploy" — "Name it, pick a model, select tools — your agent is live in seconds"
  - layers: "Multi-agent orchestration" — "Run multiple specialized agents in parallel, each handling distinct tasks"
  - timer: "Always-on execution" — "Agents run autonomously in the background — check in when you want"
- **Right**: MC Deploy visual (React component) — mock macOS window with: title bar (traffic light dots + "Mission Control" label), sidebar (icon buttons), main area (deploy form with model selector, agent name, tools toggles)

#### 5. AIProviders
- **Background**: cream (#F5F2EB)
- **Layout**: vertical, centered, padding 100px/160px
- **Header**: Section label "FLEXIBLE AI" + headline "Your AI, your choice." (Outfit 800, 48px, dark, centered) + sub-copy (centered, max-width 600px)
- **Cards**: 3 horizontal cards (Anthropic, Google Gemini, OpenAI) — each with:
  - Gradient icon square (64px, rounded-2xl, provider gradient)
  - Provider name (Outfit 700, 22px, dark)
  - Description (Outfit 400, 15px, #888, center, 1.6 line-height)
  - Model badges or recommended badge
  - White bg, rounded-2xl, subtle shadow, padding 32px
- **Provider gradients**: Anthropic (#D97706→#F59E0B), Google (#4285F4→#34A853→#FBBC05→#EA4335), OpenAI (#10A37F→#1A7F5A)

#### 6. MessagingApps
- **Background**: command (#0A0A0A)
- **Layout**: vertical, centered, padding 100px/160px
- **Header**: Section label "STAY CONNECTED" + headline "Chat with your agents anywhere." (Outfit 800, 48px, white, centered) + sub-copy (centered, max-width 650px)
- **Cards**: 3 horizontal cards (WhatsApp, Telegram, Slack) — each with:
  - Gradient icon square (56px, rounded-xl, app gradient)
  - App name (Outfit 700, 22px, white)
  - Description (Outfit 400, 15px, #999, center, 1.6 line-height)
  - Status badge (pill, colored bg at 20% opacity)
  - Dark bg (#141414), rounded-2xl, shadow, padding 32px
- **App gradients**: WhatsApp (#25D366→#128C7E), Telegram (#0088CC→#229ED9), Slack (#E01E5A→#4A154B)

#### 7. UseCases
- **Background**: cream (#F5F2EB)
- **Layout**: vertical, padding 100px/160px
- **Header**: Section label "USE CASES" + headline "Put your squad to work." (Outfit 800, 48px, dark, centered) + sub-copy (centered, max-width 600px)
- **Use cases**: 3 numbered editorial items separated by 1px dividers (#E0DCD4)
  - Each: large number (Outfit 800, 64px, brand, -3px tracking) + title (Outfit 700, 28px) + description (Outfit 400, 16px, #666, 1.6 line-height) + tag pills (rounded-full, #FFF0E8 bg, JetBrains Mono 500, 11px, brand color)
  - **01 — Research & Intelligence**: "Deploy agents that monitor 50+ sources daily, synthesize findings, and deliver briefings — so you start every morning already informed." Tags: Market monitoring, Competitor analysis, Daily briefings
  - **02 — Customer Operations**: "Triage support tickets, draft responses, and escalate edge cases around the clock. Your agents handle the volume — you handle the exceptions." Tags: Ticket triage, Auto-responses, 24/7 coverage
  - **03 — Content at Scale**: "Research, draft, edit, and publish across channels. Your content pipeline runs on autopilot while you focus on creative direction." Tags: Blog posts, Social media, Newsletters

#### 8. HowItWorks
- **Background**: command (#0A0A0A)
- **Layout**: vertical, centered, gap 56px, padding 100px/160px
- **Header**: Section label "YOUR WORKFLOW" + headline "Deploy. Run. Chat." (Outfit 800, 48px, white, centered)
- **Steps**: 3 horizontal columns with:
  - Mini visual (280px wide, 160px tall, rounded-xl, #111 bg) — simplified illustrations of each step
  - Timeline dot row (numbered circle + connecting line)
  - Step title (Outfit 700, 18px, white, centered)
  - Step description (Outfit 400, 14px, #999, centered, 1.6 line-height)
- **Step 1**: "Deploy from Mission Control" — mini MC deploy visual
- **Step 2**: "Agents work autonomously" — agent dashboard visual
- **Step 3**: "Chat via your favorite apps" — messaging icons visual

#### 9. FinalCTA
- **Background**: linear gradient (brand #FF5500 → brand-dark #CC4400)
- **Layout**: vertical, centered, gap 32px, padding 120px/160px
- **Content**: "Ready to meet your squad?" (Outfit 800, 56px, white, -3px tracking, centered) + sub-copy (Outfit 400, 20px, white/80%, centered) + **email capture form** (shadcn Input + Button, white bg, dark text, rounded-full, "Request Early Access") + note "DashSquad is free. Limited spots available." (Outfit 400, 14px, white/50%)
- **Form behavior**: POST to waitlist API, show success/error/duplicate states inline

#### 10. Footer
- **Background**: #050505
- **Layout**: vertical, gap 40px, padding 56px/160px
- **Top row**: 4 columns — Brand (logo + tagline + year), Product (Features, Early Access, How It Works), Company (About, Blog, Contact), Legal (Privacy Policy, Terms of Service)
- **Divider**: 1px #1A1A1A
- **Bottom**: "© 2026 DashSquad.ai — All rights reserved." (Outfit 400, 12px, #444)

### Static Assets

- `public/hero-squad.webp` — isometric agents hero image (already exported)

### Visuals Built as React Components

These are simplified representations of product UI, not pixel-perfect recreations:

1. **SandboxVisual** — white card showing lock icon, 3 agent status boxes, footer status
2. **MCDeployVisual** — mock macOS window with sidebar + deploy form
3. **AgentDashboardVisual** — mini agent status grid (for HowItWorks step 2)
4. **ChatAppsVisual** — messaging app icons arrangement (for HowItWorks step 3)

---

## App 2: Waitlist API (`apps/waitlist/`)

### Stack

- **Framework**: Hono (lightweight HTTP framework)
- **Database**: better-sqlite3 (SQLite)
- **Build**: tsup (ESM, consistent with monorepo)
- **Port**: 9300

### Database Schema

```sql
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### Endpoints

#### `POST /api/waitlist`

- **Request**: `{ "email": "user@example.com" }`
- **Validation**: Valid email format, non-empty
- **Response (201)**: `{ "success": true, "message": "You're on the list!" }`
- **Response (409)**: `{ "success": false, "message": "Already signed up!" }`
- **Response (400)**: `{ "success": false, "message": "Invalid email address" }`

#### `GET /api/waitlist`

- **Response (200)**: `{ "count": 42, "entries": [{ "email": "...", "created_at": "..." }, ...] }`
- No authentication (admin convenience for alpha stage)

### Configuration

- CORS enabled for homepage origin
- SQLite database stored in `data/waitlist.db`
- Graceful shutdown handling

### Package Scripts

```json
{
  "dev": "tsx watch src/index.ts",
  "build": "tsup src/index.ts",
  "start": "node dist/index.js"
}
```

---

## File Structure

```
apps/website/
├── app/
│   ├── layout.tsx          # Root layout (Outfit + JetBrains Mono fonts, metadata)
│   ├── page.tsx            # Home page (component composition)
│   └── globals.css         # Tailwind v4 @theme with brand tokens
├── components/
│   ├── ui/                 # shadcn/ui components (Button, Badge, Card, Input)
│   ├── Nav.tsx
│   ├── Hero.tsx
│   ├── SecureSandbox.tsx
│   ├── DeployAndRun.tsx
│   ├── AIProviders.tsx
│   ├── MessagingApps.tsx
│   ├── UseCases.tsx
│   ├── HowItWorks.tsx
│   ├── FinalCTA.tsx
│   ├── Footer.tsx
│   └── visuals/            # React-based product illustrations
│       ├── SandboxVisual.tsx
│       ├── MCDeployVisual.tsx
│       ├── AgentDashboardVisual.tsx
│       └── ChatAppsVisual.tsx
├── lib/
│   └── utils.ts            # shadcn/ui utility (cn function)
├── public/
│   └── hero-squad.webp
├── package.json
├── next.config.ts
├── postcss.config.mjs
├── components.json         # shadcn/ui config
└── tsconfig.json

apps/waitlist/
├── src/
│   └── index.ts            # Hono server + SQLite setup + routes
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

---

## Brand Rules (from Pencil Brand Identity System)

These rules must be followed throughout implementation:

1. **Square corners** on all functional elements (buttons, cards, inputs, containers). No border-radius except: logo icon (rounded-md), pill badges/CTAs (rounded-full), hero image (rounded-2xl).
2. **Section labels** always precede headlines: JetBrains Mono 600, 11px, ALL CAPS, +3px letter-spacing, brand color (#FF5500).
3. **Alternating section backgrounds**: dark (#0A0A0A) and cream (#F5F2EB). Never two consecutive sections with the same background.
4. **No human imagery**. Use abstract, geometric, or illustrative visuals.
5. **Alpha messaging**: CTAs say "Join the Alpha" or "Request Early Access", never "Try Free" or "Sign Up".
6. **Bold 2px strokes** on cards and containers in the brand identity, but the homepage design uses softer shadows + rounded corners on cards. Follow the homepage design (which is the production-ready interpretation of the brand rules).
7. **Font pairing**: Outfit for everything users read, JetBrains Mono for everything that signals "technical" or "system".
