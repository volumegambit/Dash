import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/agents')({
  component: () => (
    <div>
      <h1 className="text-2xl font-bold">Agents</h1>
      <p className="mt-2 text-muted">Manage your deployed Dash agents.</p>
    </div>
  ),
});
