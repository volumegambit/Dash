const DIRECT_PROVIDERS = [
  { name: 'Anthropic', models: 'Claude' },
  { name: 'OpenAI', models: 'GPT' },
  { name: 'Google', models: 'Gemini' },
  { name: 'Moonshot AI', models: 'Kimi' },
];

export function AIProviders() {
  return (
    <section className="bg-cream px-6 py-20 sm:px-8 lg:py-24">
      <div className="mx-auto max-w-[1120px]">
        <div className="max-w-[680px]">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[3px] text-brand">
            FLEXIBLE AI
          </p>
          <h2 className="mt-4 font-outfit text-[32px] font-extrabold leading-tight tracking-tight text-text-dark sm:text-[40px] lg:text-[48px]">
            Your squad. Your choice of AI.
          </h2>
          <p className="mt-5 text-[18px] leading-relaxed text-[#555]">
            Connect a supported account or bring an API key. Choose the models that fit each
            teammate&apos;s work.
          </p>
        </div>

        <div className="mt-10 grid gap-6 md:grid-cols-[1.15fr_1fr]">
          <div className="border border-cream-border bg-white p-6 sm:p-8">
            <h3 className="text-[24px] font-bold tracking-tight text-text-dark">
              Connect directly
            </h3>
            <p className="mt-2 text-[16px] leading-relaxed text-[#555]">
              Use your own API key with these providers.
            </p>
            <dl className="mt-6 divide-y divide-cream-border">
              {DIRECT_PROVIDERS.map(({ name, models }) => (
                <div key={name} className="flex items-baseline justify-between gap-4 py-4">
                  <dt className="text-[17px] font-semibold text-text-dark">{name}</dt>
                  <dd className="text-[16px] text-[#666]">{models}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="flex flex-col border border-[#cad6ee] bg-[#edf2fc] p-6 sm:p-8">
            <p className="text-[16px] font-semibold text-brand">OpenRouter</p>
            <h3 className="mt-5 max-w-[320px] text-[32px] font-bold leading-tight tracking-tight text-text-dark sm:text-[36px]">
              More models, one key.
            </h3>
            <p className="mt-4 max-w-[360px] text-[17px] leading-relaxed text-[#555]">
              Connect OpenRouter to choose from a wider model catalog with a single API key. Explore
              different models as your squad grows.
            </p>
            <div className="mt-auto pt-8">
              <p className="border-t border-[#cad6ee] pt-5 text-[14px] leading-relaxed text-[#555]">
                Model access and usage charges depend on your provider account.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
