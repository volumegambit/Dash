const FEATURES = [
  {
    title: 'Give every teammate a role',
    description:
      'Set its instructions, choose a model, and connect the tools it needs for the job.',
  },
  {
    title: 'Keep useful context',
    description:
      'Let teammates remember preferences and project details. Review, edit, or remove those memories.',
  },
  {
    title: 'Keep the work together',
    description: 'Organize tasks in projects, follow progress, and see what needs your input.',
  },
];

export function DeployAndRun() {
  return (
    <section aria-labelledby="delegation-title" className="bg-command px-6 py-20 sm:px-8 lg:py-24">
      <div className="mx-auto grid max-w-[1120px] items-center gap-12 lg:grid-cols-2 lg:gap-16">
        <div>
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[3px] text-[#93b4fb]">
            More than a single chat
          </p>
          <h2
            id="delegation-title"
            className="mt-4 text-[32px] font-extrabold leading-[1.12] tracking-tight text-white sm:text-[44px]"
          >
            Delegate the work.
            <br />
            Stay in the conversation.
          </h2>
          <p className="mt-5 text-[17px] leading-relaxed text-[#b3b3b3]">
            Give an agent a bigger brief and it can bring in helpers. Follow their activity, inspect
            their work, and guide the next step from the conversation.
          </p>
          <dl className="mt-8 space-y-6">
            {FEATURES.map(({ title, description }) => (
              <div key={title} className="border-l-2 border-brand pl-5">
                <dt className="text-base font-semibold text-white">{title}</dt>
                <dd className="mt-1 text-[15px] leading-relaxed text-[#b3b3b3]">{description}</dd>
              </div>
            ))}
          </dl>
        </div>
        <figure className="min-w-0 border border-surface-muted bg-surface">
          <figcaption className="border-b border-surface-muted px-6 py-4 font-mono text-[10px] uppercase tracking-[2px] text-[#b3b3b3]">
            Example workflow
          </figcaption>
          <div className="space-y-6 p-6 sm:p-8">
            <div className="ml-6 border border-brand/40 bg-brand/10 p-5">
              <p className="text-xs font-semibold text-[#93b4fb]">You</p>
              <p className="mt-2 text-[17px] leading-relaxed text-white">
                Help me plan the launch. Research the options and draft an announcement.
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold text-[#b3b3b3]">Your agent brings in help</p>
              <ul className="mt-3 divide-y divide-surface-muted border border-surface-muted">
                <li className="px-5 py-4">
                  <p className="font-semibold text-white">Research helper</p>
                  <p className="mt-1 text-sm leading-relaxed text-[#b3b3b3]">
                    Compare the options and gather sources.
                  </p>
                </li>
                <li className="px-5 py-4">
                  <p className="font-semibold text-white">Writing helper</p>
                  <p className="mt-1 text-sm leading-relaxed text-[#b3b3b3]">
                    Shape the brief into an announcement draft.
                  </p>
                </li>
              </ul>
            </div>
            <p className="border-t border-surface-muted pt-5 text-sm leading-relaxed text-[#b3b3b3]">
              Their work comes back to the conversation. You review it and decide what happens next.
            </p>
          </div>
        </figure>
      </div>
    </section>
  );
}
