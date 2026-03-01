import { Outlet, createRootRoute } from '@tanstack/react-router';
import { Sidebar } from '../components/Sidebar';

export const Route = createRootRoute({
  component: () => (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <main className="flex-1 overflow-auto p-8">
        <Outlet />
      </main>
    </div>
  ),
});
