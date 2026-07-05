import { Link, Outlet, createFileRoute } from '@tanstack/react-router';

interface SettingsTab {
  to: string;
  label: string;
  exact?: boolean;
}

const tabs: SettingsTab[] = [
  { to: '/settings', label: 'General', exact: true },
  { to: '/settings/agent-defaults', label: 'Agent Defaults' },
  { to: '/settings/devices', label: 'Devices' },
];

export function SettingsLayout(): JSX.Element {
  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Page header */}
      <div className="bg-surface px-8 pt-4 border-b border-border shrink-0">
        <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground">
          Settings
        </h1>
        <p className="mt-1 text-sm text-muted">Application settings and configuration.</p>
        <nav aria-label="Settings sections" className="mt-2 flex">
          {tabs.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              activeOptions={{ exact: tab.exact ?? false }}
              className="px-5 py-3.5 text-[13px] font-medium text-muted transition-colors hover:text-foreground [&.active]:border-b-2 [&.active]:border-accent [&.active]:font-semibold [&.active]:text-foreground"
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </div>

      {/* Active tab body */}
      <div className="flex-1 overflow-y-auto p-8">
        <Outlet />
      </div>
    </div>
  );
}

export const Route = createFileRoute('/settings')({
  component: SettingsLayout,
});
