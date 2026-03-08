import Link from 'next/link'

const STEPS = [
  {
    n: 1,
    code: 'git clone github.com/volumegambit/Dash && cd Dash',
    label: 'Clone the repo',
  },
  {
    n: 2,
    code: 'npm install && cp -r config.example config',
    label: 'Install dependencies and copy config',
  },
  {
    n: 3,
    code: 'npm run dev',
    label: 'Start the agent server',
  },
]

export function QuickStart() {
  return (
    <section className="bg-[#f5f5f5] px-6 py-24">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="mb-4 text-3xl font-bold tracking-tight text-[#0a0a0a]">
          Get started in minutes
        </h2>
        <p className="mb-12 text-[#525252]">Node.js 22+ and an Anthropic API key are all you need.</p>

        <div className="overflow-hidden rounded-xl border border-[#262626] bg-[#0d0d0d] text-left">
          <div className="flex items-center gap-2 border-b border-[#262626] bg-[#0a0a0a] px-4 py-3">
            <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
            <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
            <span className="h-3 w-3 rounded-full bg-[#28c840]" />
          </div>
          <div className="divide-y divide-[#1a1a1a] px-6 py-2">
            {STEPS.map((s) => (
              <div key={s.n} className="flex items-start gap-4 py-4">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#3b82f6] font-mono text-xs font-bold text-white">
                  {s.n}
                </span>
                <div>
                  <p className="font-mono text-sm text-[#fafafa]">{s.code}</p>
                  <p className="mt-1 text-xs text-[#a3a3a3]">{s.label}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <Link
          href="https://docs.dashsquad.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 inline-block text-sm text-[#3b82f6] hover:underline"
          aria-label="Full setup guide"
        >
          Full setup guide →
        </Link>
      </div>
    </section>
  )
}
