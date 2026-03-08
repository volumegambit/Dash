# Agent Chat Button Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Chat" button to the agent detail page that navigates to `/chat` with the specific agent pre-selected via URL search params.

**Architecture:** Two small changes — (1) a Chat button in `agents/$id.tsx` that navigates with `search: { deploymentId, agentName }`, (2) `validateSearch` + `useState` initialization in `chat.tsx` to read those params on arrival.

**Tech Stack:** React, TanStack Router, Zustand, Vitest + Testing Library, lucide-react

---

### Task 1: Export `AgentDetail` and write a failing test

**Files:**
- Modify: `apps/mission-control/src/renderer/src/routes/agents/$id.tsx`
- Create: `apps/mission-control/src/renderer/src/routes/agents/$id.test.tsx`

**Step 1: Export `AgentDetail` from `$id.tsx`**

On line 7 of `apps/mission-control/src/renderer/src/routes/agents/$id.tsx`, change:

```tsx
function AgentDetail(): JSX.Element {
```
to:
```tsx
export function AgentDetail(): JSX.Element {
```

**Step 2: Create the test file**

Create `apps/mission-control/src/renderer/src/routes/agents/$id.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useDeploymentsStore } from '../../stores/deployments.js';

const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ component: opts.component }),
  useNavigate: () => mockNavigate,
  useParams: () => ({ id: 'dep-1' }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

const { AgentDetail } = await import('./$id.js');

const runningDeployment = {
  id: 'dep-1',
  name: 'Developer',
  status: 'running' as const,
  createdAt: new Date().toISOString(),
  managementPort: 53891,
  chatPort: 53892,
  agentServerPid: 1,
  gatewayPid: 2,
  config: {
    agents: { myAgent: { model: 'claude-sonnet-4-6', systemPrompt: '' } },
  },
};

describe('AgentDetail', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    useDeploymentsStore.setState({
      deployments: [runningDeployment],
      loading: false,
      error: null,
      logLines: {},
    });
  });

  it('shows Chat button when agent is running', async () => {
    render(<AgentDetail />);
    expect(await screen.findByRole('button', { name: /chat/i })).toBeInTheDocument();
  });

  it('Chat button navigates to /chat with deploymentId and agentName', async () => {
    const user = userEvent.setup();
    render(<AgentDetail />);
    await user.click(await screen.findByRole('button', { name: /chat/i }));
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/chat',
      search: { deploymentId: 'dep-1', agentName: 'myAgent' },
    });
  });

  it('does not show Chat button when agent is stopped', async () => {
    useDeploymentsStore.setState({
      deployments: [{ ...runningDeployment, status: 'stopped' as const }],
      loading: false,
      error: null,
      logLines: {},
    });
    render(<AgentDetail />);
    // Wait for loading to finish
    await screen.findByText('Developer');
    expect(screen.queryByRole('button', { name: /chat/i })).not.toBeInTheDocument();
  });
});
```

**Step 3: Run tests to confirm they fail**

From repo root (`/Users/gerry/Projects/claude-workspace/Projects/Dash/.claude/worktrees/agent_chat_button`):

```bash
npx vitest run apps/mission-control/src/renderer/src/routes/agents --reporter=verbose
```

Expected: FAIL — `AgentDetail` exports but Chat button doesn't exist yet.

---

### Task 2: Implement the Chat button in `agents/$id.tsx`

**Files:**
- Modify: `apps/mission-control/src/renderer/src/routes/agents/$id.tsx`

**Step 1: Add `MessageSquare` to the lucide-react import**

Change line 3:
```tsx
import { ArrowLeft, Circle, Loader, Square, Trash2 } from 'lucide-react';
```
to:
```tsx
import { ArrowLeft, Circle, Loader, MessageSquare, Square, Trash2 } from 'lucide-react';
```

**Step 2: Derive `agentName` in `AgentDetail`**

After line 72 (`const agentConfig = ...`), add:

```tsx
const agentName =
  deployment.config?.agents ? Object.keys(deployment.config.agents)[0] ?? '' : '';
```

**Step 3: Add the Chat button to the header action row**

In the `<div className="flex items-center gap-2">` block (around line 92), add the Chat button as the first button inside:

```tsx
{isRunning && (
  <button
    type="button"
    onClick={() => navigate({ to: '/chat', search: { deploymentId: id, agentName } })}
    className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
  >
    <MessageSquare size={14} />
    Chat
  </button>
)}
```

Place it before the existing Stop button.

**Step 4: Run tests to confirm they pass**

```bash
npx vitest run apps/mission-control/src/renderer/src/routes/agents --reporter=verbose
```

Expected: All 3 tests PASS.

**Step 5: Commit**

```bash
git add apps/mission-control/src/renderer/src/routes/agents/\$id.tsx \
        apps/mission-control/src/renderer/src/routes/agents/\$id.test.tsx
git commit -m "feat(agents): add Chat button to agent detail page"
```

---

### Task 3: Add search param test for `chat.tsx`

**Files:**
- Create: `apps/mission-control/src/renderer/src/routes/chat.test.tsx`

**Step 1: Create the test file**

Create `apps/mission-control/src/renderer/src/routes/chat.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { mockApi } from '../../../../vitest.setup.js';
import { useDeploymentsStore } from '../stores/deployments.js';
import { useChatStore } from '../stores/chat.js';

const mockUseSearch = vi.fn().mockReturnValue({ deploymentId: '', agentName: '' });

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    component: opts.component,
    useSearch: mockUseSearch,
  }),
}));

const { Chat } = await import('./chat.js');

const dep1 = {
  id: 'dep-1',
  name: 'Developer',
  status: 'running' as const,
  createdAt: new Date().toISOString(),
  managementPort: 53891,
  chatPort: 53892,
  agentServerPid: 1,
  gatewayPid: 2,
  config: { agents: { myAgent: { model: 'claude-sonnet-4-6', systemPrompt: '' } } },
};

describe('Chat search params', () => {
  beforeEach(() => {
    mockUseSearch.mockReturnValue({ deploymentId: '', agentName: '' });
    useDeploymentsStore.setState({
      deployments: [dep1],
      loading: false,
      error: null,
      logLines: {},
    });
    useChatStore.setState({
      conversations: [],
      selectedConversationId: null,
      messages: {},
      streamingEvents: {},
      sending: {},
    });
    mockApi.chatListConversations.mockResolvedValue([]);
  });

  it('loads conversations for the deployment passed via search params', async () => {
    mockUseSearch.mockReturnValue({ deploymentId: 'dep-1', agentName: 'myAgent' });
    render(<Chat />);
    await screen.findByText('Chat');
    expect(mockApi.chatListConversations).toHaveBeenCalledWith('dep-1');
  });

  it('falls back to auto-selecting first running deployment when no search params', async () => {
    mockUseSearch.mockReturnValue({ deploymentId: '', agentName: '' });
    render(<Chat />);
    await screen.findByText('Chat');
    expect(mockApi.chatListConversations).toHaveBeenCalledWith('dep-1');
  });
});
```

**Step 2: Run test to confirm it fails**

```bash
npx vitest run apps/mission-control/src/renderer/src/routes/chat.test --reporter=verbose
```

Expected: FAIL — `Chat` is not exported, `Route.useSearch` not called yet.

---

### Task 4: Implement search params in `chat.tsx`

**Files:**
- Modify: `apps/mission-control/src/renderer/src/routes/chat.tsx`

**Step 1: Export `Chat` component**

Change the function declaration (around line 139):
```tsx
function Chat(): JSX.Element {
```
to:
```tsx
export function Chat(): JSX.Element {
```

**Step 2: Add `validateSearch` to the route definition**

Change the export at the bottom of the file (around line 377):
```tsx
export const Route = createFileRoute('/chat')({
  component: Chat,
});
```
to:
```tsx
export const Route = createFileRoute('/chat')({
  validateSearch: (search: Record<string, unknown>) => ({
    deploymentId: (search.deploymentId as string) ?? '',
    agentName: (search.agentName as string) ?? '',
  }),
  component: Chat,
});
```

**Step 3: Read search params and use them to initialize state**

At the top of the `Chat` function body, before the existing store destructuring, add:

```tsx
const search = Route.useSearch();
```

Then change the two `useState` initializations (around lines 156–158):
```tsx
const [selectedDeploymentId, setSelectedDeploymentId] = useState('');
const [selectedAgentName, setSelectedAgentName] = useState('');
```
to:
```tsx
const [selectedDeploymentId, setSelectedDeploymentId] = useState(search.deploymentId || '');
const [selectedAgentName, setSelectedAgentName] = useState(search.agentName || '');
```

No other changes needed — the existing `useEffect` auto-select hooks already guard with `!selectedDeploymentId` / `!selectedAgentName`, so they won't override pre-filled values.

**Step 4: Run all tests**

```bash
npx vitest run --reporter=verbose
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add apps/mission-control/src/renderer/src/routes/chat.tsx \
        apps/mission-control/src/renderer/src/routes/chat.test.tsx
git commit -m "feat(chat): pre-select agent via URL search params"
```

---

### Task 5: Verify end-to-end in the app

Start the app and confirm the full flow:

```bash
npm run dev
```

1. Navigate to **Agents** → click a running agent → see the **Chat** button in the header
2. Click **Chat** — should land on `/chat` with the correct agent already selected in the deployment/agent dropdowns
3. Click **New conversation** — should work as normal
