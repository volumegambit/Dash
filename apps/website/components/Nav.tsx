import { Button } from '@/components/ui/button';
import { Apple } from 'lucide-react';

const RELEASES_URL = 'https://github.com/volumegambit/Dash/releases/latest';

export function Nav() {
  return (
    <nav className="flex flex-row items-center justify-between py-5 px-8 lg:px-20">
      {/* Left: logo + wordmark */}
      <a href="/" className="flex items-center gap-3">
        <span className="shadow-[0_0_16px_rgba(37,99,235,0.25)] rounded-md">
          <svg
            width="28"
            height="28"
            viewBox="0 0 28 28"
            fill="none"
            aria-label="DashSquad logo"
            role="img"
          >
            <rect width="28" height="28" rx="6" fill="#2563eb" />
            <path
              d="M17.5 11L21 14L17.5 17"
              stroke="white"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M11 8L15 11L11 14"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M11 14L15 17L11 20"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="font-outfit text-xl font-extrabold text-white tracking-tight">
          dashsquad
        </span>
      </a>

      {/* Right: download CTA */}
      <Button size="pill" variant="default" asChild>
        <a href={RELEASES_URL} target="_blank" rel="noreferrer">
          <Apple size={14} className="mr-1.5" />
          Download
        </a>
      </Button>
    </nav>
  );
}
