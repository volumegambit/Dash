import { Link } from '@tanstack/react-router';
import {
  Bot,
  Cable,
  Globe,
  LayoutDashboard,
  LifeBuoy,
  MessageCircle,
  MessageSquare,
  Plug,
  Settings,
  Terminal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { GatewayStatus } from '../../../shared/ipc.js';
import { DashSquadLogo } from './DashSquadLogo.js';
import { HealthDot } from './HealthDot.js';

type HealthStatus = 'connected' | 'connecting' | 'disconnected';

interface NavItemDef {
  to: string;
  label: string;
  icon: LucideIcon;
}

interface NavSection {
  label: string;
  items: NavItemDef[];
}

const sections: NavSection[] = [
  {
    label: 'CORE',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/chat', label: 'Chat', icon: MessageCircle },
    ],
  },
  {
    label: 'MANAGE',
    items: [
      { to: '/agents', label: 'Agents', icon: Bot },
      { to: '/messaging-apps', label: 'Messaging Apps', icon: MessageSquare },
    ],
  },
  {
    label: 'CONFIGURE',
    items: [
      { to: '/connections', label: 'AI Providers', icon: Plug },
      { to: '/connectors', label: 'Connectors (MCP)', icon: Cable },
      { to: '/web-search', label: 'Web Search', icon: Globe },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
  ...(import.meta.env.DEV
    ? [
        {
          label: 'DEVELOPER',
          items: [{ to: '/under-the-hood', label: 'Under the Hood', icon: Terminal }],
        },
      ]
    : []),
];

export function Sidebar(): JSX.Element {
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>('starting');

  useEffect(() => {
    window.api.gatewayGetStatus().then(setGatewayStatus);
    return window.api.gatewayOnStatus(setGatewayStatus);
  }, []);

  const gatewayHealth: HealthStatus =
    gatewayStatus === 'healthy'
      ? 'connected'
      : gatewayStatus === 'unhealthy'
        ? 'disconnected'
        : 'connecting';

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-border bg-sidebar-bg p-3.5">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-1 pb-4 pt-3">
        <DashSquadLogo />
        <HealthDot health={gatewayHealth} />
      </div>

      {/* Nav */}
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto py-2">
        {sections.map((section, sectionIndex) => (
          <div key={section.label}>
            <span
              className={`block font-[family-name:var(--font-mono)] text-[9px] font-semibold uppercase tracking-[3px] text-accent px-3 py-1.5${sectionIndex > 0 ? ' pt-4' : ''}`}
            >
              {section.label}
            </span>
            {section.items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="flex items-center gap-2.5 h-9 px-3 text-sm text-muted hover:bg-sidebar-hover hover:text-foreground transition-colors [&.active]:bg-sidebar-active [&.active]:text-foreground [&.active]:font-semibold [&.active]:border-l-[3px] [&.active]:border-accent"
              >
                <item.icon size={16} />
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="flex items-center gap-2 px-3 py-3">
        <LifeBuoy size={14} className="text-muted" />
        <button
          type="button"
          onClick={() => window.api.openExternal('https://discord.gg/REPLACE_WITH_REAL_INVITE')}
          className="font-[family-name:var(--font-mono)] text-[11px] text-muted tracking-wide hover:text-foreground transition-colors"
        >
          Feedback
        </button>
      </div>
    </aside>
  );
}
