import {
  Bot,
  type LucideIcon,
  MessageSquare,
  Monitor,
  Server,
  Shield,
  Terminal,
} from 'lucide-react';

const FEATURES: { icon: LucideIcon; title: string; description: string }[] = [
  {
    icon: Bot,
    title: 'Your agents, your LLMs',
    description:
      'Connect Anthropic, OpenAI, Google, or any major LLM provider to power your agents.',
  },
  {
    icon: Monitor,
    title: 'Mission Control',
    description: 'Desktop app to deploy, monitor, and chat with your agents from one place.',
  },
  {
    icon: Terminal,
    title: 'CLI & automation',
    description: 'Manage agents from the terminal or wire them into automated workflows.',
  },
  {
    icon: Server,
    title: 'Runs anywhere',
    description: 'Your machine, a VPS, or a private cloud. Your data never leaves your computer.',
  },
  {
    icon: MessageSquare,
    title: 'Multi-channel',
    description: 'Reach your agents via Telegram, WebSocket API, or the built-in chat interface.',
  },
  {
    icon: Shield,
    title: 'Safe by default',
    description: 'Secrets encrypted at rest, agents sandboxed, and access controlled from day one.',
  },
];

export function Features() {
  return (
    <section className="bg-[#f5f5f5] px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <h2 className="mb-4 text-center text-3xl font-bold tracking-tight text-[#0a0a0a]">
          Everything you need to run an AI team
        </h2>
        <p className="mb-16 text-center text-[#525252]">
          Built for operators who want control, not complexity.
        </p>
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-xl border border-[#e5e5e5] bg-white p-6 shadow-sm"
            >
              <f.icon className="mb-4 h-6 w-6 text-[#3b82f6]" />
              <h3 className="mb-2 font-semibold text-[#0a0a0a]">{f.title}</h3>
              <p className="text-sm text-[#525252]">{f.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
