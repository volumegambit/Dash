import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/deploy')({
  component: () => (
    <div>
      <h1 className="text-2xl font-bold">Deploy</h1>
      <p className="mt-2 text-muted">Deploy a new Dash agent locally or to the cloud.</p>
    </div>
  ),
});
