import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Image from 'next/image';

export function Hero() {
  return (
    <section className="bg-command flex flex-col gap-6 pt-20 pb-15 px-8 lg:px-[120px]">
      {/* Two-column hero */}
      <div className="flex flex-col lg:flex-row items-center gap-12 lg:gap-16">
        {/* Left: text content */}
        <div className="flex flex-col gap-6 lg:flex-1">
          <Badge variant="default" className="w-fit">
            <span className="w-2 h-2 rounded-full bg-brand" />
            Now in Alpha — Early Access Open
          </Badge>

          <h1 className="font-outfit text-4xl md:text-5xl lg:text-[64px] font-extrabold text-white tracking-tight leading-[1.1]">
            You bring the ambition.
            <br />
            We bring the squad.
          </h1>

          <p className="text-[19px] text-text-secondary leading-relaxed max-w-[550px]">
            DashSquad lets you create AI agents — each with its own role. A researcher, a writer, an
            analyst. They work on their own, around the clock, even when you&apos;re not watching.
            Just chat with them like you&apos;d message a coworker.
          </p>

          <a href="#waitlist" className="w-fit">
            <Button size="lg">Join the Alpha</Button>
          </a>
        </div>

        {/* Right: hero image */}
        <div className="overflow-hidden lg:flex-1">
          <Image
            src="/hero-squad.webp"
            alt="AI Squad collaborating"
            width={900}
            height={500}
            className="w-full"
            priority
          />
        </div>
      </div>
    </section>
  );
}
