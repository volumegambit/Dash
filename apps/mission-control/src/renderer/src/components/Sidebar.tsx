import { Link } from '@tanstack/react-router';

const navItems = [
  { to: '/', label: 'Dashboard', icon: '~' },
  { to: '/agents', label: 'Agents', icon: '>' },
  { to: '/deploy', label: 'Deploy', icon: '+' },
  { to: '/secrets', label: 'Secrets', icon: '#' },
  { to: '/settings', label: 'Settings', icon: '*' },
] as const;

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
            <span className="font-mono text-xs">{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="border-t border-border p-4">
        <p className="text-xs text-muted">Dash v0.1.0</p>
      </div>
    </aside>
  );
}
