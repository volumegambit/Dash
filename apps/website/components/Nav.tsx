import { Button } from '@/components/ui/button';

export function Nav() {
  return (
    <nav className="flex flex-row items-center justify-between py-5 px-8 lg:px-20">
      {/* Left: logo + wordmark */}
      <a href="#" className="flex items-center gap-3">
        <span className="shadow-[0_0_16px_rgba(255,85,0,0.25)] rounded-md">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <rect width="28" height="28" rx="6" fill="#FF5500" />
            <path d="M17.5 11L21 14L17.5 17" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M11 8L15 11L11 14" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M11 14L15 17L11 20" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="font-outfit text-xl font-extrabold text-white tracking-tight">dashsquad</span>
      </a>

      {/* Right: nav links + CTA */}
      <div className="flex items-center gap-6">
        <a href="#about" className="text-[15px] text-text-secondary hover:text-white transition-colors">
          About
        </a>
        <a href="#early-access" className="text-[15px] text-text-secondary hover:text-white transition-colors">
          Early Access
        </a>
        <a href="#waitlist">
          <Button size="pill" variant="default">Join the Alpha</Button>
        </a>
      </div>
    </nav>
  );
}
