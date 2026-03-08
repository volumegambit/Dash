export function AppScreenshot() {
  return (
    <section className="bg-white px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <h2 className="mb-4 text-center text-3xl font-bold tracking-tight text-[#0a0a0a]">
          Mission Control
        </h2>
        <p className="mb-12 text-center text-[#525252]">
          Deploy agents, monitor activity, and chat — all from one desktop app.
        </p>

        {/* macOS window frame */}
        <div className="mx-auto max-w-4xl overflow-hidden rounded-xl border border-[#262626] bg-[#0d0d0d] shadow-2xl">
          {/* Title bar */}
          <div className="flex items-center gap-2 border-b border-[#262626] bg-[#0a0a0a] px-4 py-3">
            <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
            <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
            <span className="h-3 w-3 rounded-full bg-[#28c840]" />
            <span className="mx-auto font-mono text-xs text-[#a3a3a3]">Mission Control</span>
          </div>
          {/* Placeholder */}
          <div
            data-testid="screenshot-placeholder"
            className="flex h-80 items-center justify-center bg-[#111111]"
          >
            <div className="text-center">
              <p className="font-mono text-sm text-[#3b82f6]">Mission Control</p>
              <p className="mt-2 font-mono text-xs text-[#a3a3a3]">
                Add screenshot.png to public/ to display here
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
