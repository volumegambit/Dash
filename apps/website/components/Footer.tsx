import { Logo } from '@/components/Logo';

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
      </div>

      <hr className="border-divider" />

      <p className="text-xs text-text-dim">&copy; 2026 DashSquad.ai — All rights reserved.</p>
    </footer>
  );
}
