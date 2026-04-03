import { Hash, MessageCircle, Send } from 'lucide-react';

const APPS = [
  {
    gradient: 'linear-gradient(180deg, #25D366, #128C7E)',
    Icon: MessageCircle,
    name: 'WhatsApp',
    description:
      'Scan a QR code and your agents are live on WhatsApp. Message them from your phone just like any contact.',
    statusBg: 'bg-[#25D36620]',
    statusText: 'text-[#25D366]',
    dotBg: 'bg-[#25D366]',
    statusLabel: 'Available',
  },
  {
    gradient: 'linear-gradient(180deg, #0088CC, #229ED9)',
    Icon: Send,
    name: 'Telegram',
    description:
      'Create a Telegram bot in seconds and connect it to any of your agents. Full bot API support built in.',
    statusBg: 'bg-[#0088CC20]',
    statusText: 'text-[#0088CC]',
    dotBg: 'bg-[#0088CC]',
    statusLabel: 'Available',
  },
  {
    gradient: 'linear-gradient(180deg, #E01E5A, #4A154B)',
    Icon: Hash,
    name: 'Slack',
    description:
      'Add your agents to any Slack channel. They respond to mentions, DMs, and threads — just like a teammate.',
    statusBg: 'bg-[#4A154B20]',
    statusText: 'text-[#E01E5A]',
    dotBg: 'bg-[#E01E5A]',
    statusLabel: 'Coming Soon',
  },
];

export function MessagingApps() {
  return (
    <section className="bg-command py-[100px] px-8 lg:px-[160px]">
      {/* Header */}
      <div className="flex flex-col items-center gap-4">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[3px] text-brand">
          STAY CONNECTED
        </span>
        <h2 className="font-outfit text-[32px] lg:text-[48px] font-extrabold text-white tracking-tight text-center">
          Chat with your agents anywhere.
        </h2>
        <p className="text-[18px] text-text-secondary max-w-[650px] text-center leading-relaxed">
          Connect your agents to the messaging apps you already use. Talk to them like you'd message
          a coworker — from your phone, your desktop, wherever you are.
        </p>
      </div>

      {/* Cards */}
      <div className="flex flex-col md:flex-row gap-6 pt-12">
        {APPS.map(
          ({ gradient, Icon, name, description, statusBg, statusText, dotBg, statusLabel }) => (
            <div
              key={name}
              className="bg-surface shadow-lg p-8 flex-1 flex flex-col items-center gap-5"
            >
              {/* Gradient icon */}
              <div
                className="w-14 h-14 flex items-center justify-center"
                style={{ background: gradient }}
              >
                <Icon size={24} color="white" />
              </div>

              {/* Name */}
              <span className="text-[22px] font-bold text-white">{name}</span>

              {/* Description */}
              <p className="text-[15px] text-[#999] text-center leading-relaxed">{description}</p>

              {/* Status badge */}
              <div
                className={`px-3 py-1 text-[11px] font-semibold flex items-center gap-1.5 ${statusBg} ${statusText}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${dotBg}`} />
                {statusLabel}
              </div>
            </div>
          ),
        )}
      </div>
    </section>
  );
}
