import { Logo } from '@/components/Logo';
import { DOCS_URL, DOWNLOAD_URL, REPO_URL } from '@/lib/site';

const LINK_COLUMNS = [
  {
    title: 'Get started',
    links: [
      { label: 'Download for Mac', href: DOWNLOAD_URL, external: true },
      { label: 'User guide', href: `${DOCS_URL}/introduction`, external: true },
      { label: 'GitHub', href: REPO_URL, external: true },
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
    <footer className="border-t border-surface-border bg-footer-bg px-6 py-14 sm:px-8">
      <div className="mx-auto max-w-[1120px]">
        <div className="flex flex-col justify-between gap-10 md:flex-row">
          <div className="max-w-[320px]">
            <a href="/" aria-label="DashSquad home" className="flex items-center gap-2.5">
              <Logo size={28} className="rounded-md" />
              <span className="text-xl font-extrabold tracking-tight text-white">dashsquad</span>
            </a>
            <p className="mt-4 text-sm leading-relaxed text-[#a3a3a3]">
              Your AI team. Built around you.
            </p>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-12 gap-y-8 sm:gap-x-20">
            {LINK_COLUMNS.map((column) => (
              <div key={column.title}>
                <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[2px] text-[#a3a3a3]">
                  {column.title}
                </h2>
                <ul className="mt-4 space-y-3">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        {...(link.external ? { target: '_blank', rel: 'noreferrer' } : {})}
                        className="text-sm text-[#b3b3b3] transition-colors hover:text-white"
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
        <p className="mt-12 border-t border-surface-border pt-6 text-xs text-[#a3a3a3]">
          &copy; {new Date().getFullYear()} DashSquad. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
