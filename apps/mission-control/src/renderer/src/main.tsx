import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createHashHistory, createRouter } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './assets/main.css';
import { routeTree } from './routeTree.gen';

const queryClient = new QueryClient();
const hashHistory = createHashHistory();
const router = createRouter({ routeTree, history: hashHistory });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
