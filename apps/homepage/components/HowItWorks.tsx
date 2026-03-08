function ArchNode({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center">
      <div className="rounded-lg border border-[#262626] bg-[#0d0d0d] px-5 py-3 text-center shadow-lg">
        <p className="font-mono text-sm font-semibold text-white">{label}</p>
        {sub && <p className="mt-0.5 font-mono text-xs text-[#a3a3a3]">{sub}</p>}
      </div>
    </div>
  )
}

function Arrow({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-2">
      {label && <span className="font-mono text-xs text-[#a3a3a3]">{label}</span>}
      <div className="flex items-center gap-0">
        <div className="h-px w-10 bg-[#3b82f6]" />
        <div className="border-y-4 border-l-4 border-r-0 border-y-transparent border-l-[#3b82f6]" />
      </div>
    </div>
  )
}

const DESCRIPTIONS = [
  {
    title: 'Agent Server',
    desc: 'Hosts your agents and exposes Chat (WebSocket) and Management (HTTP) APIs. Runs on a VPS, private cloud, or your local machine.',
  },
  {
    title: 'Gateway',
    desc: 'Connects to Telegram and other platforms, routing messages to agents via the Chat API. One process, one config for all channels.',
  },
  {
    title: 'Mission Control',
    desc: 'Desktop app or CLI for deploying, monitoring, and chatting with agents. Connects to both the gateway and agent server.',
  },
]

export function HowItWorks() {
  return (
    <section className="bg-white px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <h2 className="mb-4 text-center text-3xl font-bold tracking-tight text-[#0a0a0a]">
          How it works
        </h2>
        <p className="mb-16 text-center text-[#525252]">
          Three components. Deploy together or split across machines.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-4 overflow-x-auto py-4">
          <ArchNode label="Chat Platforms" sub="Telegram, etc." />
          <Arrow label="Bot API" />
          <ArchNode label="Gateway" sub=":9200" />
          <Arrow label="WebSocket" />
          <ArchNode label="Agent Server" sub=":9100 · :9101" />
          <div className="flex flex-col items-center gap-2">
            <span className="font-mono text-xs text-[#a3a3a3]">Deploy &amp; Manage</span>
            <div className="flex items-center">
              <div className="border-y-4 border-l-0 border-r-4 border-y-transparent border-r-[#3b82f6]" />
              <div className="h-px w-10 bg-[#3b82f6]" />
            </div>
          </div>
          <ArchNode label="Mission Control" sub="Desktop / CLI" />
        </div>

        <div className="mt-16 grid grid-cols-1 gap-6 sm:grid-cols-3">
          {DESCRIPTIONS.map((c) => (
            <div key={c.title} className="rounded-lg border border-[#e5e5e5] p-5">
              <p className="text-sm text-[#525252]">
                <strong className="mb-1 block font-semibold text-[#0a0a0a]">{c.title}:</strong>
                {c.desc}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
