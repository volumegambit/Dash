import { Button } from '@/components/ui/button';

export function Nav() {
  return (
    <nav className="flex flex-row items-center justify-between py-5 px-8 lg:px-20">
      {/* Left: logo + wordmark */}
      <a href="#" className="flex items-center gap-3">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <rect x="2" y="2" width="24" height="24" rx="4" stroke="#3A8B6B" strokeWidth="2" fill="none" />
          <line x1="2" y1="10" x2="26" y2="10" stroke="#3A8B6B" strokeWidth="1.5" />
          <path d="M14 22C14 22 11 17 11 14C11 11 13 9 14 8C15 9 17 11 17 14C17 17 14 22 14 22Z" fill="#3A8B6B" />
        </svg>
        <span className="font-outfit text-xl font-semibold text-white tracking-tight">atrium</span>
      </a>

      {/* Right: nav links + CTA */}
      <div className="flex items-center gap-6">
        <a href="#about" className="hidden md:block text-[15px] text-text-secondary hover:text-white transition-colors">
          About
        </a>
        <a href="#early-access" className="hidden md:block text-[15px] text-text-secondary hover:text-white transition-colors">
          Early Access
        </a>
        <a href="#waitlist">
          <Button size="pill" variant="default">Join the Alpha</Button>
        </a>
      </div>
    </nav>
  );
}
