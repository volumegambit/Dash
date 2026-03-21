import { Badge } from '@/components/ui/badge';

const USE_CASES = [
  {
    number: '01',
    title: 'Research & Intelligence',
    description:
      'Deploy agents that monitor 50+ sources daily, synthesize findings, and deliver briefings — so you start every morning already informed.',
    tags: ['Market monitoring', 'Competitor analysis', 'Daily briefings'],
  },
  {
    number: '02',
    title: 'Customer Operations',
    description:
      'Triage support tickets, draft responses, and escalate edge cases around the clock. Your agents handle the volume — you handle the exceptions.',
    tags: ['Ticket triage', 'Auto-responses', '24/7 coverage'],
  },
  {
    number: '03',
    title: 'Content at Scale',
    description:
      'Research, draft, edit, and publish across channels. Your content pipeline runs on autopilot while you focus on creative direction.',
    tags: ['Blog posts', 'Social media', 'Newsletters'],
  },
];

export function UseCases() {
  return (
    <section className="bg-cream py-[100px] px-8 lg:px-[160px]">
      {/* Header */}
      <div className="flex flex-col items-center gap-4">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[3px] text-brand">
          USE CASES
        </span>
        <h2 className="text-[32px] lg:text-[48px] font-extrabold text-text-dark tracking-tight text-center">
          Put your squad to work.
        </h2>
        <p className="text-[18px] text-text-muted text-center max-w-[600px]">
          Not hypotheticals. These are the things people actually deploy agents for.
        </p>
      </div>

      {/* Use cases list */}
      <div className="flex flex-col pt-12">
        {/* Top divider */}
        <div className="h-px w-full bg-cream-border" />

        {USE_CASES.map((useCase) => (
          <div key={useCase.number}>
            <div className="flex flex-col md:flex-row gap-10 py-10">
              {/* Number */}
              <span className="text-[48px] lg:text-[64px] font-extrabold text-brand tracking-[-3px] leading-[0.9] min-w-[80px]">
                {useCase.number}
              </span>

              {/* Content */}
              <div className="flex flex-col gap-2 flex-1">
                <h3 className="text-[28px] font-bold text-text-dark tracking-tight">
                  {useCase.title}
                </h3>
                <p className="text-[16px] text-text-muted leading-relaxed">
                  {useCase.description}
                </p>
                <div className="flex flex-wrap gap-2 pt-2">
                  {useCase.tags.map((tag) => (
                    <Badge key={tag} variant="tag" size="sm">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
            <div className="h-px w-full bg-cream-border" />
          </div>
        ))}
      </div>
    </section>
  );
}
