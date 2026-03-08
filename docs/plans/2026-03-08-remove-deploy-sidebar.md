# Remove Deploy Entry from Mission Control Sidebar

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the redundant "Deploy" nav entry from the Mission Control sidebar — deploy is already accessible from the Agents page.

**Architecture:** Single-file change to `Sidebar.tsx`: remove one entry from `navItems` and its unused import. The `/deploy` route is untouched.

**Tech Stack:** React 19, Lucide React icons, TanStack Router, Vitest + React Testing Library

---

### Task 1: Remove Deploy from sidebar nav

**Files:**
- Modify: `apps/mission-control/src/renderer/src/components/Sidebar.tsx`
- Create: `apps/mission-control/src/renderer/src/components/Sidebar.test.tsx`

**Step 1: Write the failing test**

Create `apps/mission-control/src/renderer/src/components/Sidebar.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar } from './Sidebar.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

describe('Sidebar', () => {
  it('renders all expected nav items', () => {
    render(<Sidebar />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Secrets')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('does not render a Deploy nav item', () => {
    render(<Sidebar />);
    expect(screen.queryByText('Deploy')).not.toBeInTheDocument();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run apps/mission-control/src/renderer/src/components/Sidebar.test.tsx
```

Expected: FAIL — `expect(screen.queryByText('Deploy')).not.toBeInTheDocument()` fails because Deploy is currently present.

**Step 3: Remove Deploy from navItems**

In `apps/mission-control/src/renderer/src/components/Sidebar.tsx`, make these two changes:

Change the import line from:
```tsx
import { Bot, KeyRound, LayoutDashboard, MessageCircle, Rocket, Settings } from 'lucide-react';
```
To:
```tsx
import { Bot, KeyRound, LayoutDashboard, MessageCircle, Settings } from 'lucide-react';
```

Remove this line from `navItems`:
```tsx
  { to: '/deploy', label: 'Deploy', icon: Rocket },
```

The final `navItems` array should look like:
```tsx
const navItems: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/chat', label: 'Chat', icon: MessageCircle },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/secrets', label: 'Secrets', icon: KeyRound },
  { to: '/settings', label: 'Settings', icon: Settings },
];
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run apps/mission-control/src/renderer/src/components/Sidebar.test.tsx
```

Expected: 2 tests PASS.

Then run the full suite to confirm nothing is broken:

```bash
npx vitest run
```

Expected: all tests pass (existing count + 2 new).

**Step 5: Commit**

```bash
git add apps/mission-control/src/renderer/src/components/Sidebar.tsx \
        apps/mission-control/src/renderer/src/components/Sidebar.test.tsx
git commit -m "feat(mission-control): remove Deploy from sidebar nav

Deploy is already accessible from the Agents page header and empty state.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```
