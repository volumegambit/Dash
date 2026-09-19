const EXAMPLES = [
  {
    role: 'A research partner',
    title: 'Compare your options.',
    description: 'Explore a question, compare options, and pull the useful details into a brief.',
    prompt: 'Compare these options and give me a shortlist with sources.',
  },
  {
    role: 'A writing partner',
    title: 'Get past the blank page.',
    description:
      'Turn rough notes into a first draft, then work together to make it sound like you.',
    prompt: 'Turn these notes into a clear update for the team.',
  },
  {
    role: 'A project partner',
    title: 'Turn a brief into tasks.',
    description: 'Break a brief into tasks and keep track of the work that needs your attention.',
    prompt: 'Help me turn this project brief into tasks and next steps.',
  },
];

export function EverydayWork() {
  return (
    <section aria-labelledby="everyday-work-title" className="bg-cream px-6 py-20 sm:px-8 lg:py-24">
      <div className="mx-auto max-w-[1120px]">
        <div className="max-w-[650px]">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[3px] text-brand">
            Put your squad to work
          </p>
          <h2
            id="everyday-work-title"
            className="mt-4 text-[32px] font-extrabold leading-[1.12] tracking-tight text-text-dark sm:text-[44px]"
          >
            For the work already on your plate.
          </h2>
          <p className="mt-5 text-[17px] leading-relaxed text-text-faint">
            Start with one teammate for a task you do often. Add others when you need a different
            kind of help.
          </p>
        </div>
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {EXAMPLES.map(({ role, title, description, prompt }) => (
            <article
              key={role}
              className="flex flex-col border border-cream-border bg-white p-6 lg:p-8"
            >
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[1.5px] text-brand">
                {role}
              </p>
              <h3 className="mt-5 text-[24px] font-bold leading-tight tracking-tight text-text-dark">
                {title}
              </h3>
              <p className="mb-8 mt-4 text-[15px] leading-relaxed text-text-faint">{description}</p>
              <div className="mt-auto border-t border-cream-border pt-5">
                <p className="mb-2 text-xs font-medium text-text-muted">A brief to try</p>
                <p className="text-[15px] leading-relaxed text-text-dark">&ldquo;{prompt}&rdquo;</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
