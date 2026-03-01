import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/secrets')({
  component: () => (
    <div>
      <h1 className="text-2xl font-bold">Secrets</h1>
      <p className="mt-2 text-muted">Manage API keys, tokens, and credentials for your agents.</p>
    </div>
  ),
});
