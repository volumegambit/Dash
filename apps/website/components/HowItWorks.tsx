import { Button } from '@/components/ui/button';
import { DOCS_URL, DOWNLOAD_URL } from '@/lib/site';

const STEPS = [
  {
    title: 'Download DashSquad',
    description:
      'Get the Mac app for Apple silicon or Intel. Open it to set up your first teammate.',
  },
  {
    title: 'Connect your AI',
    description: 'Sign in with a supported AI account or add an API key from your chosen provider.',
  },
  {
    title: 'Make it yours',
    description:
      'Give your teammate a name and a role, choose its model and tools, and start a conversation.',
  },
];

const QUESTIONS = [
  {
    question: 'Where can I use DashSquad?',
    answer:
      'DashSquad is in early access, with desktop downloads for Mac on Apple silicon and Intel.',
  },
  {
    question: 'How do I pay for the AI?',
    answer:
      'AI access is separate from DashSquad. Your provider subscription or API usage charges apply, depending on how you connect.',
  },
  {
    question: 'Does my Mac need to stay on?',
    answer:
      'Your squad needs a running host. If you run it on your Mac, keep your Mac awake and online for background work and remote access.',
  },
  {
    question: 'Where does my data go?',
    answer:
      'Your workspace lives on the computer running your squad. AI requests go to your chosen providers; connected tools may send data to other services. Hosted remote access also passes traffic through DashSquad’s relay.',
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="scroll-mt-20 bg-command px-6 py-20 sm:px-8 lg:py-24">
      <div className="mx-auto max-w-[1120px]">
        <div className="max-w-[680px]">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[3px] text-[#8aafff]">
            GET STARTED
          </p>
          <h2 className="mt-4 text-[32px] font-extrabold leading-tight tracking-tight text-white sm:text-[40px] lg:text-[48px]">
            Start with one teammate.
          </h2>
          <p className="mt-5 text-[18px] leading-relaxed text-[#b3b3b3]">
            Give it a task you already need to do. Build your squad from there.
          </p>
        </div>

        <ol className="mt-12 grid gap-8 md:grid-cols-3 md:gap-10">
          {STEPS.map(({ title, description }, index) => (
            <li key={title} className="border-t border-[#333] pt-6">
              <span className="font-mono text-[14px] text-[#8aafff]" aria-hidden="true">
                0{index + 1}
              </span>
              <h3 className="mt-4 text-[22px] font-bold text-white">{title}</h3>
              <p className="mt-3 text-[16px] leading-relaxed text-[#b3b3b3]">{description}</p>
            </li>
          ))}
        </ol>

        <div className="mt-20 border-t border-[#333] pt-10">
          <h3 className="text-[26px] font-bold tracking-tight text-white">
            Before you get started
          </h3>
          <dl className="mt-8 grid gap-x-12 gap-y-8 md:grid-cols-2">
            {QUESTIONS.map(({ question, answer }) => (
              <div key={question}>
                <dt className="text-[18px] font-semibold text-white">{question}</dt>
                <dd className="mt-3 text-[16px] leading-relaxed text-[#b3b3b3]">{answer}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="mt-12 flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:gap-8">
          <Button size="lg" asChild>
            <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
              Download for Mac
            </a>
          </Button>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="py-2 text-[16px] font-semibold text-white underline underline-offset-4 transition-colors hover:text-[#8aafff] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#8aafff]"
          >
            Read the guide
          </a>
        </div>
      </div>
    </section>
  );
}
