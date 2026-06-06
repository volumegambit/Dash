import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { Apple } from 'lucide-react';

const RELEASES_URL = 'https://github.com/volumegambit/Dash/releases/latest';

export function Nav() {
  return (
    <nav className="flex flex-row items-center justify-between py-5 px-8 lg:px-20">
      {/* Left: logo + wordmark */}
      <a href="/" className="flex items-center gap-3">
        <span className="shadow-[0_0_16px_rgba(37,99,235,0.25)] rounded-md">
          <Logo size={28} className="rounded-md" />
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
