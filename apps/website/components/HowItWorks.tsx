import { Rocket } from 'lucide-react';
import { AgentDashboardVisual } from '@/components/visuals/AgentDashboardVisual';
import { ChatAppsVisual } from '@/components/visuals/ChatAppsVisual';

function MCInlineVisual() {
  return (
    <div className="bg-surface overflow-hidden w-[280px] h-[160px]">
      {/* Title bar */}
      <div className="h-6 bg-[#111] border-b border-surface-border flex items-center gap-1 px-2">
        <span className="w-1.5 h-1.5 rounded-full bg-surface-muted" />
        <span className="w-1.5 h-1.5 rounded-full bg-surface-muted" />
        <span className="w-1.5 h-1.5 rounded-full bg-surface-muted" />
      </div>
      {/* Body */}
      <div className="flex items-center justify-center h-[calc(100%-24px)]">
        <Rocket size={32} className="text-brand" />
      </div>
    </div>
  );
}

const STEPS = [
  {
    visual: <MCInlineVisual />,
    title: 'Deploy from Mission Control',
    desc: 'Configure and launch agents with the visual deploy wizard. Select models, set tools, and deploy in seconds.',
    hasConnector: true,
  },
  {
    visual: <AgentDashboardVisual />,
    title: 'Agents work autonomously',
    desc: 'Your AI agents run independently, handling tasks and making decisions — just like real teammates.',
    hasConnector: true,
  },
  {
    visual: <ChatAppsVisual />,
    title: 'Chat via your favorite apps',
    desc: 'Interact through WhatsApp, Telegram, Slack, or any messaging platform you already use.',
    hasConnector: false,
  },
];

export function HowItWorks() {
  return (
    <section className="bg-command py-[100px] px-8 lg:px-[160px] flex flex-col items-center gap-14">
      {/* Header */}
      <div className="flex flex-col items-center gap-4">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[3px] text-brand">
          YOUR WORKFLOW
        </span>
        <h2 className="text-[32px] lg:text-[48px] font-extrabold text-white tracking-tight text-center">
          Deploy. Run. Chat.
        </h2>
      </div>

      {/* Steps */}
      <div className="flex flex-col md:flex-row gap-0 w-full">
        {STEPS.map((step, i) => (
          <div key={step.title} className="flex-1 flex flex-col items-center gap-5 px-5">
            {/* Mini visual */}
            {step.visual}

            {/* Timeline */}
            <div className="flex items-center justify-center h-9 relative w-full">
              <div className="w-9 h-9 rounded-full bg-brand text-white text-sm font-bold flex items-center justify-center z-10">
                {i + 1}
              </div>
              {step.hasConnector && (
                <div className="hidden md:block absolute h-px bg-surface-border top-1/2 left-[calc(50%+18px)] right-0" />
              )}
            </div>

            {/* Text */}
            <h3 className="text-[18px] font-bold text-white text-center">{step.title}</h3>
            <p className="text-[14px] text-[#999] text-center leading-relaxed">{step.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
