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
        The space where your<br />work comes together.
      </h1>

      {/* Sub-copy */}
      <p className="text-[19px] text-text-secondary text-center leading-relaxed max-w-[750px]">
        Atrium is the personal operating system for people who build. AI agents that learn, remember, and compound your advantage — in a space that&apos;s entirely yours.
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
          className="rounded-2xl shadow-[0_8px_40px_rgba(125,211,252,0.12)]"
          priority
        />
      </div>
    </section>
  );
}
