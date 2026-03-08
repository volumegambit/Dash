import Link from 'next/link';

const LINKS = [
  { label: 'GitHub', href: 'https://github.com/volumegambit/Dash' },
  { label: 'Docs', href: 'https://docs.dashsquad.ai' },
  { label: 'Discord', href: 'https://discord.gg/dash' },
];

export function Footer() {
  return (
    <footer className="border-t border-[#262626] bg-[#0a0a0a] px-6 py-8">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
        <span className="font-mono text-sm text-[#a3a3a3]">© 2026 DashSquad</span>
        <nav className="flex gap-6">
          {LINKS.map((l) => (
            <Link
              key={l.label}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={l.label}
              className="text-sm text-[#a3a3a3] transition-colors hover:text-white"
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
