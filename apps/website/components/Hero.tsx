import Image from 'next/image';
import { Search, FileText, Mail, BarChart3, TrendingUp, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const USE_CASE_PILLS = [
  { Icon: Search, label: 'Research competitors' },
  { Icon: FileText, label: 'Draft blog posts' },
  { Icon: Mail, label: 'Summarize emails' },
  { Icon: BarChart3, label: 'Analyze reports' },
  { Icon: TrendingUp, label: 'Monitor trends' },
  { Icon: MessageSquare, label: 'Answer questions' },
];

export function Hero() {
  return (
    <section className="bg-command flex flex-col items-center gap-6 pt-20 pb-15 px-8 lg:px-[120px]">
      {/* Alpha Badge */}
      <Badge variant="default">
        <span className="w-2 h-2 rounded-full bg-brand" />
        Now in Alpha — Early Access Open
      </Badge>

      {/* Headline */}
      <h1 className="font-outfit text-4xl md:text-5xl lg:text-[64px] font-extrabold text-white tracking-tight leading-[1.1] text-center max-w-[900px]">
        You bring the ambition.<br />We bring the squad.
      </h1>

      {/* Sub-copy */}
      <p className="text-[19px] text-text-secondary text-center leading-relaxed max-w-[750px]">
        DashSquad lets you create AI agents — each with its own role. A researcher, a writer, an analyst. They work on their own, around the clock, even when you&apos;re not watching. Just chat with them like you&apos;d message a coworker.
      </p>

      {/* CTA Button */}
      <a href="#waitlist">
        <Button size="lg" className="rounded-full">Join the Alpha</Button>
      </a>

      {/* Use-case pills */}
      <div className="flex flex-wrap justify-center gap-2.5">
        {USE_CASE_PILLS.map(({ Icon, label }) => (
          <Badge key={label} variant="pill">
            <Icon size={16} className="text-brand" />
            <span>{label}</span>
          </Badge>
        ))}
      </div>

      {/* Hero image */}
      <div className="overflow-hidden rounded-2xl">
        <Image
          src="/hero-squad.webp"
          alt="AI Squad collaborating"
          width={900}
          height={500}
          className="rounded-2xl shadow-[0_8px_40px_rgba(255,85,0,0.12)]"
          priority
        />
      </div>
    </section>
  );
}
