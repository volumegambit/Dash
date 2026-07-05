import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import {
  Cable,
  Plug,
  Puzzle,
  SlidersHorizontal,
  Smartphone,
  TabletSmartphone,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface SettingsNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
}

interface SettingsNavGroup {
  label?: string;
  items: SettingsNavItem[];
}

const groups: SettingsNavGroup[] = [
  {
    items: [
      { to: '/settings', label: 'General', icon: Wrench, exact: true },
      { to: '/settings/agent-defaults', label: 'Agent Defaults', icon: SlidersHorizontal },
    ],
  },
  {
    label: 'PROVIDERS & TOOLS',
    items: [
      { to: '/settings/ai-providers', label: 'AI Providers', icon: Plug },
      { to: '/settings/connectors', label: 'Connectors (MCP)', icon: Cable },
      { to: '/settings/plugins', label: 'Plugins', icon: Puzzle },
    ],
  },
  {
    label: 'ACCESS',
    items: [
      { to: '/settings/messaging-apps', label: 'Messaging Apps', icon: Smartphone },
      { to: '/settings/devices', label: 'Devices', icon: TabletSmartphone },
    ],
  },
];

export function SettingsLayout(): JSX.Element {
  return (
    <div className="flex h-full overflow-hidden">
      {/* Settings sub-nav */}
      <aside className="w-52 shrink-0 overflow-y-auto border-r border-border bg-surface px-3 py-5">
        <h1 className="px-3 pb-3 font-[family-name:var(--font-display)] text-[17px] font-semibold text-foreground">
          Settings
        </h1>
        <nav aria-label="Settings sections" className="flex flex-col gap-0.5">
          {groups.map((group, groupIndex) => (
            <div key={group.label ?? groupIndex}>
              {group.label && (
                <span className="block px-3 pb-1.5 pt-4 font-[family-name:var(--font-mono)] text-[9px] font-semibold uppercase tracking-[3px] text-accent">
                  {group.label}
                </span>
              )}
              {group.items.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  activeOptions={{ exact: item.exact ?? false }}
                  className="flex h-9 items-center gap-2.5 px-3 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground [&.active]:border-l-[3px] [&.active]:border-accent [&.active]:bg-sidebar-active [&.active]:font-semibold [&.active]:text-foreground"
                >
                  <item.icon size={16} />
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {/* Active section — each child owns its header and scrolling. The pane
          scrolls horizontally below the content floor instead of clipping
          header CTAs at the 800px minimum window width. */}
      <div className="min-w-0 flex-1 overflow-x-auto">
        <div className="h-full min-w-[480px]">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/settings')({
  component: SettingsLayout,
});
