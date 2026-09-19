import { Button } from '@/components/ui/button';
import { DOWNLOAD_URL } from '@/lib/site';
import Image from 'next/image';

export function Hero() {
  return (
    <section className="bg-command px-6 pb-20 pt-12 sm:px-8 lg:pb-24 lg:pt-20">
      <div className="mx-auto grid max-w-[1120px] items-center gap-12 lg:grid-cols-[1.15fr_1fr] lg:gap-10">
        <div className="min-w-0">
          <p className="mb-6 font-mono text-[11px] font-semibold uppercase tracking-[2px] text-[#93b4fb]">
            A personal AI team · Early access for Mac
          </p>
          <h1 className="font-outfit text-[44px] font-extrabold leading-[1.04] tracking-tight text-white sm:text-[56px] lg:text-[64px]">
            Your AI team.
            <br />
            Built around you.
          </h1>
          <p className="mt-6 max-w-[520px] text-lg leading-relaxed text-[#b3b3b3]">
            Research a decision. Shape a first draft. Move a project forward. Give your AI teammates
            their own roles, models, and tools — and one place to work with you.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-7 gap-y-5">
            <Button size="lg" asChild>
              <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
                Download for Mac
              </a>
            </Button>
            <a
              href="#how-it-works"
              className="text-sm font-medium text-white underline decoration-white/30 underline-offset-4 hover:decoration-white"
            >
              See how it works
            </a>
          </div>
          <p className="mt-5 text-sm text-[#a3a3a3]">
            Apple Silicon &amp; Intel. Connect your own AI provider.
          </p>
        </div>
        <div className="mx-auto w-full max-w-[540px] overflow-hidden">
          <Image
            src="/hero-squad.webp"
            alt=""
            width={900}
            height={500}
            className="h-auto w-full"
            priority
          />
        </div>
      </div>
    </section>
  );
}
