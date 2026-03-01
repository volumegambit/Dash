import { Link } from '@tanstack/react-router';
import { Bot, KeyRound, LayoutDashboard, MessageCircle, Rocket, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const navItems: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/chat', label: 'Chat', icon: MessageCircle },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/deploy', label: 'Deploy', icon: Rocket },
  { to: '/secrets', label: 'Secrets', icon: KeyRound },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Sidebar(): JSX.Element {
  return (
    <aside className="flex h-screen w-56 shrink-0 flex-col border-r border-border bg-sidebar-bg">
      <div className="flex h-14 items-center border-b border-border px-4">
        <span className="text-sm font-semibold tracking-wide text-foreground">Mission Control</span>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-2">
        {navItems.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground [&.active]:bg-sidebar-active [&.active]:text-foreground"
          >
            <item.icon size={16} />
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
