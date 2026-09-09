// Renderer harness entry: installs a stubbed `window.api` BEFORE anything
// imports the router, then mounts the same app `main.tsx` mounts.
//
// The install has to happen at module-evaluation time and before the route
// tree is imported, because route modules touch `window.api` while rendering.
// That is why this is a separate entry rather than a flag inside `main.tsx`.
import { installStubApi } from './harness/stub-api.js';

installStubApi();

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { RouterProvider, createHashHistory, createRouter } = await import('@tanstack/react-router');
const { StrictMode } = await import('react');
const { createRoot } = await import('react-dom/client');
await import('./assets/main.css');
const { routeTree } = await import('./routeTree.gen');

const queryClient = new QueryClient();
const router = createRouter({ routeTree, history: createHashHistory() });

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  </StrictMode>,
);
