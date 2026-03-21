# Homepage & Waitlist API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the DashSquad homepage from the Pencil design and add a waitlist API for early access email capture.

**Architecture:** Clean-slate rebuild of `apps/website/` (Next.js 15 static export) with 10 page sections, shadcn/ui components with brand overrides, and Tailwind v4 design tokens. Separate `apps/waitlist/` (Hono + SQLite) for email capture. The homepage's FinalCTA form POSTs to the waitlist API.

**Tech Stack:** Next.js 15, React 19, Tailwind CSS v4, shadcn/ui, Lucide React, Outfit + JetBrains Mono (next/font/google), Hono, better-sqlite3, tsup

---

## File Map

### `apps/website/` (modify existing)

| File | Action | Responsibility |
|------|--------|----------------|
| `app/layout.tsx` | Modify | Switch fonts from GeistMono to Outfit + JetBrains Mono, update metadata |
| `app/globals.css` | Modify | Replace with Tailwind v4 @theme brand tokens |
| `app/page.tsx` | Modify | Replace component imports with new 10-section composition |
| `lib/utils.ts` | Create | shadcn/ui `cn` utility (clsx + tailwind-merge) |
| `components.json` | Create | shadcn/ui configuration |
| `components/ui/button.tsx` | Create | shadcn Button with brand overrides |
| `components/ui/badge.tsx` | Create | shadcn Badge with brand overrides |
| `components/ui/card.tsx` | Create | shadcn Card with brand overrides |
| `components/ui/input.tsx` | Create | shadcn Input with brand overrides |
| `components/Nav.tsx` | Rewrite | Nav bar from Pencil design |
| `components/Hero.tsx` | Rewrite | Hero section from Pencil design |
| `components/SecureSandbox.tsx` | Create | Secure sandbox section |
| `components/DeployAndRun.tsx` | Create | Deploy & run section |
| `components/AIProviders.tsx` | Create | AI providers section |
| `components/MessagingApps.tsx` | Create | Messaging apps section |
| `components/UseCases.tsx` | Create | Use cases section |
| `components/HowItWorks.tsx` | Rewrite | How it works section |
| `components/FinalCTA.tsx` | Create | Final CTA with email capture form |
| `components/Footer.tsx` | Rewrite | Footer from Pencil design |
| `components/visuals/SandboxVisual.tsx` | Create | Sandbox illustration component |
| `components/visuals/MCDeployVisual.tsx` | Create | MC deploy window illustration |
| `components/visuals/AgentDashboardVisual.tsx` | Create | Agent dashboard mini illustration |
| `components/visuals/ChatAppsVisual.tsx` | Create | Chat apps mini illustration |
| `public/hero-squad.webp` | Exists | Hero image (already exported from Pencil) |

### `apps/website/` (delete old)

| File | Action |
|------|--------|
| `components/AppScreenshot.tsx` | Delete |
| `components/Community.tsx` | Delete |
| `components/Features.tsx` | Delete |
| `components/QuickStart.tsx` | Delete |
| `components/AppScreenshot.test.tsx` | Delete |
| `components/Community.test.tsx` | Delete |
| `components/Features.test.tsx` | Delete |
| `components/QuickStart.test.tsx` | Delete |
| `components/Hero.test.tsx` | Delete |
| `components/HowItWorks.test.tsx` | Delete |
| `components/Nav.test.tsx` | Delete |
| `components/Footer.test.tsx` | Delete |

### `apps/waitlist/` (new app)

| File | Action | Responsibility |
|------|--------|----------------|
| `package.json` | Create | Package config, dependencies |
| `tsconfig.json` | Create | TypeScript config |
| `tsup.config.ts` | Create | Build config |
| `src/index.ts` | Create | Hono server, SQLite setup, routes, CORS |

---

## Task 1: Foundation — Install dependencies, configure shadcn/ui, set up design tokens

**Files:**
- Modify: `apps/website/package.json`
- Modify: `apps/website/app/globals.css`
- Modify: `apps/website/app/layout.tsx`
- Create: `apps/website/lib/utils.ts`
- Create: `apps/website/components.json`

- [ ] **Step 1: Install shadcn/ui dependencies**

Run in `apps/website`:
```bash
npm install clsx tailwind-merge class-variance-authority
```

- [ ] **Step 2: Remove geist font package**

Run in `apps/website`:
```bash
npm uninstall geist
```

- [ ] **Step 3: Create shadcn cn utility**

Create `apps/website/lib/utils.ts`:
```typescript
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 4: Create shadcn components.json**

Create `apps/website/components.json`:
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib"
  }
}
```

- [ ] **Step 5: Update globals.css with brand tokens**

Replace `apps/website/app/globals.css` with:
```css
@import "tailwindcss";

@theme {
  --color-brand: #FF5500;
  --color-brand-dark: #CC4400;
  --color-brand-light: #FF550015;
  --color-command: #0A0A0A;
  --color-cream: #F5F2EB;
  --color-cream-border: #E0D8CC;
  --color-amber: #FFB800;
  --color-success: #00CC66;
  --color-surface: #141414;
  --color-surface-border: #222222;
  --color-surface-muted: #333333;
  --color-text-primary: #FFFFFF;
  --color-text-secondary: #888888;
  --color-text-muted: #666666;
  --color-text-dark: #0A0A0A;
  --color-text-dim: #444444;
  --color-text-faint: #555555;
  --color-footer-bg: #050505;
  --color-divider: #1A1A1A;
  --font-outfit: 'Outfit', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}

html {
  scroll-behavior: smooth;
}

body {
  background-color: var(--color-command);
  color: var(--color-text-primary);
  font-family: var(--font-outfit);
}
```

- [ ] **Step 6: Update layout.tsx with new fonts and metadata**

Replace `apps/website/app/layout.tsx` with:
```tsx
import { Outfit, JetBrains_Mono } from 'next/font/google';
import type { Metadata } from 'next';
import './globals.css';

const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-outfit',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL('https://dashsquad.ai'),
  title: 'DashSquad — Your AI Team, Always On',
  description:
    'DashSquad lets you create AI agents — each with its own role. They work on their own, around the clock, even when you\'re not watching.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${jetbrainsMono.variable}`}>
      <body className="font-outfit">{children}</body>
    </html>
  );
}
```

- [ ] **Step 7: Verify fonts load and tokens work**

Run `npm run dev` in `apps/website` and open http://localhost:3000 — verify page loads without errors.

- [ ] **Step 8: Commit**

```bash
git add apps/website/lib/utils.ts apps/website/components.json apps/website/app/globals.css apps/website/app/layout.tsx apps/website/package.json
git commit -m "feat(website): set up brand design tokens, fonts, and shadcn/ui foundation"
```

---

## Task 2: Create shadcn/ui components with brand overrides

**Files:**
- Create: `apps/website/components/ui/button.tsx`
- Create: `apps/website/components/ui/badge.tsx`
- Create: `apps/website/components/ui/card.tsx`
- Create: `apps/website/components/ui/input.tsx`

- [ ] **Step 1: Install @radix-ui/react-slot**

Run in `apps/website`:
```bash
npm install @radix-ui/react-slot
```

- [ ] **Step 2: Create Button component**

Create `apps/website/components/ui/button.tsx` — shadcn Button using cva with variants:
- `default`: bg-brand text-white hover:bg-brand-dark
- `outline`: border border-surface-border bg-transparent
- `ghost`: text-text-secondary hover:text-text-primary
- `cta`: bg-white text-command font-bold hover:bg-cream shadow-lg
- Sizes: default (px-6 py-3), sm, lg (px-10 py-4 text-lg), pill (rounded-full)
- Uses Slot from @radix-ui/react-slot for asChild prop

- [ ] **Step 3: Create Badge component**

Create `apps/website/components/ui/badge.tsx` — cva variants:
- `default`: bg-brand-light text-brand border-brand rounded-full (for alpha badge)
- `pill`: bg-surface text-text-primary border-surface-muted rounded-full (for use-case pills)
- `tag`: bg-[#FFF0E8] text-brand font-mono text-[11px] rounded-full (for use case tags)

- [ ] **Step 4: Create Card component**

Create `apps/website/components/ui/card.tsx` — Card, CardHeader, CardTitle, CardDescription with brand defaults (rounded-2xl, p-8).

- [ ] **Step 5: Create Input component**

Create `apps/website/components/ui/input.tsx` — rounded-full, white bg, border-surface-border, text-command, focus ring brand color. Height h-12.

- [ ] **Step 6: Commit**

```bash
git add apps/website/components/ui/ apps/website/package.json
git commit -m "feat(website): add shadcn/ui Button, Badge, Card, Input with brand overrides"
```

---

## Task 3: Delete old components, build Nav and Hero

**Files:**
- Delete: `apps/website/components/AppScreenshot.tsx`, `Community.tsx`, `Features.tsx`, `QuickStart.tsx` and `apps/website/components/__tests__/` directory
- Rewrite: `apps/website/components/Nav.tsx`
- Rewrite: `apps/website/components/Hero.tsx`
- Modify: `apps/website/app/page.tsx`

- [ ] **Step 1: Delete old components and tests**

Remove: `AppScreenshot.tsx`, `Community.tsx`, `Features.tsx`, `QuickStart.tsx` from `apps/website/components/`, and delete the entire `apps/website/components/__tests__/` directory.

- [ ] **Step 2: Write Nav component**

Replace `apps/website/components/Nav.tsx`:
- Flex row, justify-between, py-5 px-20
- Left: logo icon (28px, rounded-md, bg-brand, white SVG chevron paths from Pencil design, orange glow shadow via `shadow-[0_0_16px_rgba(255,85,0,0.25)]`) + "dashsquad" wordmark (font-outfit text-xl font-extrabold text-white tracking-tight)
- Right: nav links "About", "Early Access" (text-[15px] text-text-secondary hover:text-white) + Button with size="pill" for "Join the Alpha"
- All links are `<a>` tags with `href="#section-id"` anchors

- [ ] **Step 3: Write Hero component**

Replace `apps/website/components/Hero.tsx`:
- bg-command, flex flex-col items-center gap-6, pt-20 pb-15 px-8 lg:px-[120px]
- Alpha Badge: Badge variant="default" with dot (w-2 h-2 rounded-full bg-brand) + text "Now in Alpha — Early Access Open"
- Headline: "You bring the ambition.\nWe bring the squad." — font-outfit text-4xl md:text-5xl lg:text-[64px] font-extrabold text-white tracking-tight leading-[1.1] text-center max-w-[900px]
- Sub-copy: text-[19px] text-text-secondary text-center leading-relaxed max-w-[750px]
- CTA: Button size="lg" className="rounded-full" with href="#waitlist" (scrolls to FinalCTA), text "Join the Alpha"
- Use-case pills: flex flex-wrap justify-center gap-2.5, 6 Badge variant="pill" each with lucide icon (16px, text-brand) + text
  - Search/"Research competitors", FileText/"Draft blog posts", Mail/"Summarize emails", BarChart3/"Analyze reports", TrendingUp/"Monitor trends", MessageSquare/"Answer questions"
- Hero image: `<Image src="/hero-squad.webp" alt="AI Squad" width={900} height={500} className="rounded-2xl shadow-[0_8px_40px_rgba(255,85,0,0.12)]" />`

- [ ] **Step 4: Update page.tsx with Nav + Hero only**

```tsx
import { Nav } from '@/components/Nav';
import { Hero } from '@/components/Hero';

export default function Home() {
  return (
    <main>
      <Nav />
      <Hero />
    </main>
  );
}
```

- [ ] **Step 5: Verify in browser**

Run `npm run dev`, check Nav + Hero render correctly at http://localhost:3000.

- [ ] **Step 6: Commit**

```bash
git add apps/website/components/ apps/website/app/page.tsx
git commit -m "feat(website): rebuild Nav and Hero sections from Pencil design"
```

---

## Task 4: SecureSandbox section + SandboxVisual

**Files:**
- Create: `apps/website/components/SecureSandbox.tsx`
- Create: `apps/website/components/visuals/SandboxVisual.tsx`
- Modify: `apps/website/app/page.tsx`

- [ ] **Step 1: Create SandboxVisual component**

Create `apps/website/components/visuals/SandboxVisual.tsx` — a white card (rounded-2xl, shadow-lg, p-8) containing:
- Lock icon row: centered Lock icon (lucide, 32px, text-text-dark) + "Secure Sandbox" text
- Divider: h-px bg-cream-border
- 3 agent status boxes: small frames with colored status dots (green, yellow, green) + agent names ("Research Agent", "Writer Agent", "Analyst Agent") + status text
- Divider
- Footer: green dot + "All systems nominal" (font-mono text-xs text-text-muted)

- [ ] **Step 2: Create SecureSandbox component**

Create `apps/website/components/SecureSandbox.tsx`:
- Section: bg-cream py-[100px] px-8 lg:px-[160px]
- Flex row (stacks on mobile): gap-20
- Left (flex-1): section label "BUILT FOR TRUST" (font-mono text-[11px] font-semibold uppercase tracking-[3px] text-brand) + headline "Runs on your machine.\nStays on your machine." (text-[44px] font-extrabold text-text-dark tracking-tight leading-[1.1]) + sub-copy + 4 feature bullets
- Feature bullets: flex flex-col gap-4, each with icon (ShieldCheck/HardDrive/FileSearch/EyeOff in 40px cream circle) + title + description
- Right (w-[420px]): SandboxVisual

- [ ] **Step 3: Add to page.tsx after Hero**

- [ ] **Step 4: Verify in browser**

- [ ] **Step 5: Commit**

```bash
git add apps/website/components/SecureSandbox.tsx apps/website/components/visuals/ apps/website/app/page.tsx
git commit -m "feat(website): add SecureSandbox section with sandbox visual"
```

---

## Task 5: DeployAndRun section + MCDeployVisual

**Files:**
- Create: `apps/website/components/DeployAndRun.tsx`
- Create: `apps/website/components/visuals/MCDeployVisual.tsx`
- Modify: `apps/website/app/page.tsx`

- [ ] **Step 1: Create MCDeployVisual component**

Create `apps/website/components/visuals/MCDeployVisual.tsx` — mock macOS window:
- Outer: rounded-xl bg-command border border-surface-border shadow-lg overflow-hidden
- Title bar: bg-surface py-2.5 px-3.5 flex items-center gap-2, border-b border-surface-border
  - Traffic lights: 3 circles (w-2.5 h-2.5 rounded-full) — #f87171, #facc15, #4ade80
  - Label: "Mission Control" (font-mono text-xs text-text-muted ml-2)
- Body: flex
  - Sidebar: w-14 bg-surface border-r border-surface-border, py-4, 4 icon buttons (LayoutDashboard, Rocket, MessageSquare, Settings — 20px, text-text-secondary)
  - Main: flex-1 p-6, mock deploy form: agent name input, model selector, tool toggles (simplified visual representations)

- [ ] **Step 2: Create DeployAndRun component**

Create `apps/website/components/DeployAndRun.tsx`:
- Section: bg-command py-[100px] px-8 lg:px-[160px]
- Flex row gap-16 (stacks on mobile)
- Left (flex-1): section label "GETTING STARTED" + headline "Up and running in minutes" + sub-copy + 3 bullet features (MousePointerClick, Layers, Timer icons in brand/20 circles)
- Right (flex-1): MCDeployVisual

- [ ] **Step 3: Add to page.tsx**

- [ ] **Step 4: Verify in browser**

- [ ] **Step 5: Commit**

```bash
git add apps/website/components/DeployAndRun.tsx apps/website/components/visuals/MCDeployVisual.tsx apps/website/app/page.tsx
git commit -m "feat(website): add DeployAndRun section with MC deploy visual"
```

---

## Task 6: AIProviders section

**Files:**
- Create: `apps/website/components/AIProviders.tsx`
- Modify: `apps/website/app/page.tsx`

- [ ] **Step 1: Create AIProviders component**

Create `apps/website/components/AIProviders.tsx`:
- Section: bg-cream py-[100px] px-8 lg:px-[160px]
- Header centered: section label "FLEXIBLE AI" + headline "Your AI, your choice." (text-[48px] font-extrabold text-text-dark tracking-tight text-center) + sub-copy (max-w-[600px] mx-auto text-center)
- 3 cards: flex flex-col md:flex-row gap-6 pt-10
- Each card: Card with bg-white shadow-sm, flex-col items-center gap-5
  - Gradient icon: 64px rounded-2xl, CSS gradient via inline style, centered white lucide icon (Brain/Sparkles/Zap, 28px)
  - CardTitle: provider name
  - CardDescription: text-text-secondary
  - Anthropic card gets Badge "Recommended"
- Gradients: Anthropic (#D97706→#F59E0B), Google (#4285F4→#EA4335 4-stop), OpenAI (#10A37F→#1A7F5A)

- [ ] **Step 2: Add to page.tsx**

- [ ] **Step 3: Verify in browser**

- [ ] **Step 4: Commit**

```bash
git add apps/website/components/AIProviders.tsx apps/website/app/page.tsx
git commit -m "feat(website): add AIProviders section with provider cards"
```

---

## Task 7: MessagingApps section

**Files:**
- Create: `apps/website/components/MessagingApps.tsx`
- Modify: `apps/website/app/page.tsx`

- [ ] **Step 1: Create MessagingApps component**

Create `apps/website/components/MessagingApps.tsx`:
- Section: bg-command py-[100px] px-8 lg:px-[160px]
- Header centered: section label "STAY CONNECTED" + headline "Chat with your agents anywhere." + sub-copy (max-w-[650px])
- 3 cards: flex flex-col md:flex-row gap-6 pt-12
- Each card: bg-surface rounded-2xl shadow-lg p-8, flex-col items-center gap-5
  - Gradient icon: 56px rounded-xl, app gradient, centered white lucide icon (MessageCircle/Send/Hash, 24px)
  - Name: text-[22px] font-bold text-white
  - Description: text-[15px] text-[#999] text-center leading-relaxed
  - Status badge: rounded-full pill with colored bg/20 + dot + text
- Gradients: WhatsApp (#25D366→#128C7E), Telegram (#0088CC→#229ED9), Slack (#E01E5A→#4A154B)
- Statuses: WhatsApp "Available" (green), Telegram "Available" (blue), Slack "Coming Soon" (purple)

- [ ] **Step 2: Add to page.tsx**

- [ ] **Step 3: Verify in browser**

- [ ] **Step 4: Commit**

```bash
git add apps/website/components/MessagingApps.tsx apps/website/app/page.tsx
git commit -m "feat(website): add MessagingApps section with app cards"
```

---

## Task 8: UseCases section

**Files:**
- Create: `apps/website/components/UseCases.tsx`
- Modify: `apps/website/app/page.tsx`

- [ ] **Step 1: Create UseCases component**

Create `apps/website/components/UseCases.tsx`:
- Section: bg-cream py-[100px] px-8 lg:px-[160px]
- Header centered: section label "USE CASES" + headline "Put your squad to work." + sub-copy (max-w-[600px])
- Use cases: flex flex-col pt-12
- 1px divider (bg-cream-border) before each item and after last
- Each use case: flex gap-10 py-10
  - Number: text-[64px] font-extrabold text-brand tracking-[-3px] leading-[0.9] min-w-[80px]
  - Content: flex flex-col gap-2
    - Title: text-[28px] font-bold text-text-dark tracking-tight
    - Description: text-[16px] text-text-muted leading-relaxed
    - Tags: flex gap-2 pt-2, Badge variant="tag" size="sm"
- Data:
  - 01 / "Research & Intelligence" / description / [Market monitoring, Competitor analysis, Daily briefings]
  - 02 / "Customer Operations" / description / [Ticket triage, Auto-responses, 24/7 coverage]
  - 03 / "Content at Scale" / description / [Blog posts, Social media, Newsletters]

- [ ] **Step 2: Add to page.tsx**

- [ ] **Step 3: Verify in browser**

- [ ] **Step 4: Commit**

```bash
git add apps/website/components/UseCases.tsx apps/website/app/page.tsx
git commit -m "feat(website): add UseCases section with editorial layout"
```

---

## Task 9: HowItWorks section + mini visuals

**Files:**
- Rewrite: `apps/website/components/HowItWorks.tsx`
- Create: `apps/website/components/visuals/AgentDashboardVisual.tsx`
- Create: `apps/website/components/visuals/ChatAppsVisual.tsx`
- Modify: `apps/website/app/page.tsx`

- [ ] **Step 1: Create AgentDashboardVisual**

Create `apps/website/components/visuals/AgentDashboardVisual.tsx`:
- 280x160px container, bg-surface rounded-xl p-5
- 3 agent status rows: colored dot (green/amber/green) + agent name (font-mono text-xs text-text-primary) + status text (text-xs text-text-muted)
- Simple, clean representation of agents working

- [ ] **Step 2: Create ChatAppsVisual**

Create `apps/website/components/visuals/ChatAppsVisual.tsx`:
- 280x160px container, bg-surface rounded-xl p-6
- 3 messaging app icon circles arranged centered: WhatsApp green, Telegram blue, Slack purple — each 40px circle with white lucide icon

- [ ] **Step 3: Rewrite HowItWorks component**

Replace `apps/website/components/HowItWorks.tsx`:
- Section: bg-command py-[100px] px-8 lg:px-[160px] flex flex-col items-center gap-14
- Header centered: section label "YOUR WORKFLOW" + headline "Deploy. Run. Chat."
- 3 step columns: flex flex-col md:flex-row, each step flex-1 px-5
  - Mini visual component (280x160, use smaller inline version of MCDeployVisual for step 1, AgentDashboardVisual for step 2, ChatAppsVisual for step 3)
  - Timeline: numbered circle (w-9 h-9 rounded-full bg-brand text-white font-bold flex items-center justify-center) + horizontal connecting line (h-px bg-surface-border, hidden on last step)
  - Title: text-[18px] font-bold text-white text-center
  - Description: text-[14px] text-[#999] text-center leading-relaxed

- [ ] **Step 4: Add to page.tsx**

- [ ] **Step 5: Verify in browser**

- [ ] **Step 6: Commit**

```bash
git add apps/website/components/HowItWorks.tsx apps/website/components/visuals/ apps/website/app/page.tsx
git commit -m "feat(website): add HowItWorks section with step visuals"
```

---

## Task 10: Waitlist API (`apps/waitlist/`)

**Files:**
- Create: `apps/waitlist/package.json`
- Create: `apps/waitlist/tsconfig.json`
- Create: `apps/waitlist/tsup.config.ts`
- Create: `apps/waitlist/src/index.ts`

- [ ] **Step 1: Create package.json**

Create `apps/waitlist/package.json`:
```json
{
  "name": "@dash/waitlist",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsup src/index.ts",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "hono": "^4.0.0",
    "@hono/node-server": "^1.0.0",
    "better-sqlite3": "^11.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.0.0",
    "tsup": "^8.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `apps/waitlist/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "declaration": true,
    "isolatedModules": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create tsup.config.ts**

Create `apps/waitlist/tsup.config.ts`:
```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  dts: true,
  external: ['better-sqlite3'],
});
```

- [ ] **Step 4: Create the Hono server**

Create `apps/waitlist/src/index.ts`:
- Import: serve from @hono/node-server, Hono, cors from hono/cors, Database from better-sqlite3
- Config: DB_PATH from env (default `data/waitlist.db`), PORT from env (default 9300), CORS_ORIGIN from env (default `http://localhost:3000`)
- Ensure data directory exists with mkdirSync
- Initialize SQLite with WAL mode, create waitlist table
- CORS middleware on /api/*
- POST /api/waitlist: validate email regex, insert, handle UNIQUE constraint → 409, invalid → 400, success → 201
- GET /api/waitlist: return count + entries ordered by created_at DESC
- Graceful shutdown: close db on SIGINT/SIGTERM

- [ ] **Step 5: Install dependencies**

Run `npm install` from repo root to resolve workspace.

- [ ] **Step 6: Test the API manually**

Start the dev server, test with curl:
- POST valid email → 201 success
- POST same email → 409 duplicate
- POST invalid email → 400 error
- GET → list with count
Clean up test data after.

- [ ] **Step 7: Add data/ to .gitignore**

Ensure `apps/waitlist/data/` is gitignored so the SQLite database doesn't get committed. Add `data/` to `apps/waitlist/.gitignore` or to the root `.gitignore`.

- [ ] **Step 8: Commit**

```bash
git add apps/waitlist/
git commit -m "feat(waitlist): add Hono + SQLite waitlist API for early access signups"
```

---

## Task 11: FinalCTA section with email capture form

**Files:**
- Create: `apps/website/components/FinalCTA.tsx`
- Modify: `apps/website/app/page.tsx`

- [ ] **Step 1: Create FinalCTA component**

Create `apps/website/components/FinalCTA.tsx`:
- Section: id="waitlist", bg-gradient-to-b from-brand to-brand-dark, py-[120px] px-8 lg:px-[160px], flex flex-col items-center gap-8
- Headline: "Ready to meet your squad?" — text-4xl lg:text-[56px] font-extrabold text-white tracking-[-3px] text-center
- Sub-copy: text-[20px] text-white/80 text-center
- WaitlistForm: extracted to a separate file `components/WaitlistForm.tsx` with `'use client'` directive at the top of that file. FinalCTA.tsx imports it as a server component wrapper.
  - useState: email (string), status ('idle' | 'loading' | 'success' | 'error' | 'duplicate'), message (string)
  - Form: flex gap-3 w-full max-w-md
    - Input type="email" placeholder="Enter your email"
    - Button variant="cta" className="rounded-full whitespace-nowrap" — "Request Early Access"
  - On submit: fetch POST to `process.env.NEXT_PUBLIC_WAITLIST_URL ?? 'http://localhost:9300'` + '/api/waitlist'
  - Status display: success (green check + message), error/duplicate (red/amber message)
- Note: "DashSquad is free. Limited spots available." — text-[14px] text-white/50

- [ ] **Step 2: Add to page.tsx**

- [ ] **Step 3: Verify form renders and submits**

Start waitlist API and website dev server. Test form submission in browser.

- [ ] **Step 4: Commit**

```bash
git add apps/website/components/FinalCTA.tsx apps/website/app/page.tsx
git commit -m "feat(website): add FinalCTA section with email capture form"
```

---

## Task 12: Footer section + final page composition

**Files:**
- Rewrite: `apps/website/components/Footer.tsx`
- Modify: `apps/website/app/page.tsx`

- [ ] **Step 1: Rewrite Footer component**

Replace `apps/website/components/Footer.tsx`:
- Section: bg-footer-bg py-14 px-8 lg:px-[160px] flex flex-col gap-10
- Top row: flex flex-col md:flex-row gap-16
  - Brand (w-[300px]): logo (same SVG as Nav) + "Your AI team, always on." (text-[14px] text-text-muted) + "DashSquad.ai · 2026" (text-xs text-text-dim)
  - Product: title "Product" (text-xs font-semibold text-text-faint uppercase tracking-wide) + links (text-[14px] text-text-secondary): Features, Early Access, How It Works
  - Company: About, Blog, Contact
  - Legal: Privacy Policy, Terms of Service
- Divider: h-px bg-divider
- Bottom: "© 2026 DashSquad.ai — All rights reserved." (text-xs text-text-dim)
- Links use `<a>` with href="#section-id" for internal, href="/" for placeholder external

- [ ] **Step 2: Update page.tsx with all 10 sections**

Final `apps/website/app/page.tsx`:
```tsx
import { Nav } from '@/components/Nav';
import { Hero } from '@/components/Hero';
import { SecureSandbox } from '@/components/SecureSandbox';
import { DeployAndRun } from '@/components/DeployAndRun';
import { AIProviders } from '@/components/AIProviders';
import { MessagingApps } from '@/components/MessagingApps';
import { UseCases } from '@/components/UseCases';
import { HowItWorks } from '@/components/HowItWorks';
import { FinalCTA } from '@/components/FinalCTA';
import { Footer } from '@/components/Footer';

export default function Home() {
  return (
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
  );
}
```

- [ ] **Step 3: Verify complete page in browser**

Scroll through all 10 sections, verify alternating backgrounds, correct content, working CTA form.

- [ ] **Step 4: Commit**

```bash
git add apps/website/components/Footer.tsx apps/website/app/page.tsx
git commit -m "feat(website): add Footer, complete page composition with all 10 sections"
```

---

## Task 13: Build verification, responsive polish, and root scripts

**Files:**
- Modify: various components for responsive breakpoints
- Modify: root `package.json`

- [ ] **Step 1: Run production build**

```bash
cd apps/website && npm run build
```

Fix any build errors.

- [ ] **Step 2: Add responsive breakpoints to all sections**

Key responsive patterns to apply across all section components:
- Padding: `px-8 lg:px-[160px]` (already in plan)
- Horizontal splits: `flex-col lg:flex-row`
- Card rows: `flex-col md:flex-row`
- Hero headline: `text-[36px] md:text-[48px] lg:text-[64px]`
- Section headlines: `text-[32px] md:text-[40px] lg:text-[48px]`
- Use case numbers: `text-[48px] lg:text-[64px]`
- Nav: hide links on mobile, show hamburger or simplify

- [ ] **Step 3: Run lint and fix issues**

```bash
npm run lint
```

- [ ] **Step 4: Ensure vitest doesn't fail on empty test suite**

Check `apps/website/vitest.config.ts` — if tests were deleted, ensure the test command doesn't error. Add `passWithNoTests: true` to vitest config if needed. Also check if `vitest.setup.ts` exists and clean up any references to deleted test utilities.

- [ ] **Step 5: Add waitlist scripts to root package.json**

Add to root `package.json` scripts:
```json
"waitlist:dev": "npm run dev --workspace=apps/waitlist",
"waitlist:build": "npm run build --workspace=apps/waitlist"
```

- [ ] **Step 6: Final build verification**

```bash
cd apps/website && npm run build
cd apps/waitlist && npm run build
```

Both should succeed.

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "feat(website): add responsive breakpoints, fix build, add root scripts"
```
