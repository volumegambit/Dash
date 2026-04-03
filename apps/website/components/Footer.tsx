export function Footer() {
  return (
    <footer className="bg-footer-bg py-14 px-8 lg:px-[160px] flex flex-col gap-10">
      {/* Top row */}
      <div className="flex flex-col md:flex-row gap-16">
        {/* Brand column */}
        <div className="md:w-[300px]">
          <a href="#" className="flex items-center gap-2.5">
            <span className="shadow-[0_0_16px_rgba(255,85,0,0.25)] rounded-md">
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                <rect width="28" height="28" rx="6" fill="#FF5500" />
                <path d="M17.5 11L21 14L17.5 17" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M11 8L15 11L11 14" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M11 14L15 17L11 20" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
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
