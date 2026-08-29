import { Logo } from '@/components/Logo';

const RELEASES_URL = 'https://github.com/volumegambit/Dash/releases/latest';
const REPO_URL = 'https://github.com/volumegambit/Dash';

const LINK_COLUMNS = [
  {
    title: 'Product',
    links: [
      { label: 'Download for Mac', href: RELEASES_URL, external: true },
      { label: 'Source on GitHub', href: REPO_URL, external: true },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Privacy Policy', href: '/privacy_policy/', external: false },
      { label: 'Terms of Service', href: '/terms_of_service/', external: false },
    ],
  },
];

export function Footer() {
  return (
    <footer className="bg-footer-bg py-14 px-8 lg:px-[160px] flex flex-col gap-10">
      {/* Top row */}
      <div className="flex flex-col md:flex-row gap-16">
        {/* Brand column */}
        <div className="md:w-[300px]">
          <a href="/" className="flex items-center gap-2.5">
            <span className="shadow-[0_0_16px_rgba(37,99,235,0.25)] rounded-md">
              <Logo size={28} className="rounded-md" />
            </span>
            <span className="text-xl font-extrabold text-white tracking-tight">dashsquad</span>
          </a>
          <p className="text-[14px] text-text-muted mt-3">Your AI team, always on.</p>
          <p className="text-xs text-text-dim mt-1">DashSquad.ai &middot; 2026</p>
        </div>

        {/* Link columns */}
        <nav aria-label="Footer" className="flex flex-row gap-16">
          {LINK_COLUMNS.map((column) => (
            <div key={column.title} className="flex flex-col gap-3">
              <span className="font-mono text-[11px] font-semibold uppercase tracking-[2px] text-text-faint">
                {column.title}
              </span>
              <ul className="flex flex-col gap-2.5">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      {...(link.external ? { target: '_blank', rel: 'noreferrer' } : {})}
                      className="text-[14px] text-text-muted hover:text-white transition-colors"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>

      <hr className="border-divider" />

      <p className="text-xs text-text-dim">&copy; 2026 DashSquad.ai — All rights reserved.</p>
    </footer>
  );
}
