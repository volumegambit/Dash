import { MousePointerClick, Layers, Timer } from 'lucide-react';
import { MCDeployVisual } from '@/components/visuals/MCDeployVisual';

const BULLETS = [
  {
    Icon: MousePointerClick,
    title: 'Point-and-click deploy',
    description: 'Name it, pick a model, select tools — your agent is live in seconds',
  },
  {
    Icon: Layers,
    title: 'Multi-agent orchestration',
    description: 'Run multiple specialized agents in parallel, each handling distinct tasks',
  },
  {
    Icon: Timer,
    title: 'Always-on execution',
    description: 'Agents run autonomously in the background — check in when you want',
  },
];

export function DeployAndRun() {
  return (
    <section className="bg-command py-[100px] px-8 lg:px-[160px]">
      <div className="flex flex-col lg:flex-row gap-16 items-center">
        {/* Left side */}
        <div className="flex-1 flex flex-col gap-8">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[3px] text-brand">
            GETTING STARTED
          </span>

          <h2 className="font-outfit text-[32px] lg:text-[48px] font-extrabold text-white tracking-tight leading-[1.1]">
            Up and running in minutes
          </h2>

          <p className="text-[18px] text-text-secondary leading-relaxed">
            Deploy autonomous AI agents from Mission Control — no terminal needed. Configure, launch, and manage your entire squad from one dashboard.
          </p>

          {/* Feature bullets */}
          <div className="flex flex-col gap-5">
            {BULLETS.map(({ Icon, title, description }) => (
              <div key={title} className="flex items-start gap-4">
                <div className="w-12 h-12 bg-brand/20 flex items-center justify-center shrink-0">
                  <Icon size={24} className="text-brand" />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[16px] font-semibold text-white">{title}</span>
                  <span className="text-[14px] text-text-secondary leading-relaxed">{description}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right side */}
        <div className="flex-1">
          <MCDeployVisual />
        </div>
      </div>
    </section>
  );
}
