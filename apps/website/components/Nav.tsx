import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { DOCS_URL, DOWNLOAD_URL } from '@/lib/site';

export function Nav() {
  return (
    <header className="bg-command px-6 sm:px-8">
      <nav
        aria-label="Main"
        className="mx-auto flex max-w-[1120px] items-center justify-between gap-4 py-5"
      >
        <a href="/" aria-label="DashSquad home" className="flex shrink-0 items-center gap-2.5">
          <Logo size={28} className="rounded-md" />
          <span className="text-xl font-extrabold tracking-tight text-white">dashsquad</span>
        </a>
        <div className="flex items-center gap-6">
          <a
            href={`${DOCS_URL}/introduction`}
            className="hidden text-sm text-[#b3b3b3] hover:text-white sm:block"
          >
            User guide
          </a>
          <Button size="sm" asChild>
            <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
              Download
            </a>
          </Button>
        </div>
      </nav>
    </header>
  );
}
