export function Footer() {
  return (
    <footer className="bg-footer-bg py-14 px-8 lg:px-[160px] flex flex-col gap-10">
      {/* Top row */}
      <div className="flex flex-col md:flex-row gap-16">
        {/* Brand column */}
        <div className="md:w-[300px]">
          <a href="#" className="flex items-center gap-2.5">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <rect x="2" y="2" width="24" height="24" rx="4" stroke="#7DD3FC" strokeWidth="2" fill="none" />
              <line x1="2" y1="10" x2="26" y2="10" stroke="#7DD3FC" strokeWidth="1.5" />
              <path d="M14 22C14 22 11 17 11 14C11 11 13 9 14 8C15 9 17 11 17 14C17 17 14 22 14 22Z" fill="#7DD3FC" />
            </svg>
            <span className="text-xl font-extrabold text-white tracking-tight">atrium</span>
          </a>
          <p className="text-[14px] text-text-muted mt-3">Your personal operating system.</p>
          <p className="text-xs text-text-dim mt-1">Atrium · 2026</p>
        </div>

      </div>

      <hr className="border-divider" />

      <p className="text-xs text-text-dim">© 2026 Atrium — All rights reserved.</p>
    </footer>
  );
}
