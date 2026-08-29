import { Footer } from '@/components/Footer';
import { Nav } from '@/components/Nav';

const PROSE = [
  '[&>section]:flex [&>section]:flex-col [&>section]:gap-3 [&>section]:pt-12',
  '[&_h2]:text-[24px] [&_h2]:font-bold [&_h2]:text-white [&_h2]:tracking-tight',
  '[&_h3]:text-[17px] [&_h3]:font-semibold [&_h3]:text-white [&_h3]:pt-2',
  '[&_p]:text-[16px] [&_p]:text-text-secondary [&_p]:leading-relaxed',
  '[&_ul]:flex [&_ul]:flex-col [&_ul]:gap-2 [&_ul]:pl-5 [&_ul]:list-disc',
  '[&_li]:text-[16px] [&_li]:text-text-secondary [&_li]:leading-relaxed [&_li]:marker:text-brand',
  '[&_strong]:text-white [&_strong]:font-semibold',
  '[&_a]:text-brand [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-white',
  '[&_code]:font-mono [&_code]:text-[13px] [&_code]:bg-surface [&_code]:text-[#bbb] [&_code]:px-1.5 [&_code]:py-0.5',
].join(' ');

type LegalPageProps = {
  eyebrow: string;
  title: string;
  lastUpdated: string;
  intro: string;
  children: React.ReactNode;
};

/** Shared shell for the privacy policy and terms of service pages. */
export function LegalPage({ eyebrow, title, lastUpdated, intro, children }: LegalPageProps) {
  return (
    <main>
      <Nav />

      <section className="bg-command px-8 lg:px-20 pt-16 pb-24">
        <div className="max-w-[760px] mx-auto">
          <header className="flex flex-col gap-4">
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[3px] text-brand">
              {eyebrow}
            </span>
            <h1 className="font-outfit text-4xl lg:text-[52px] font-extrabold text-white tracking-tight leading-[1.1]">
              {title}
            </h1>
            <p className="text-[17px] text-text-secondary leading-relaxed">{intro}</p>
            <p className="text-[13px] text-text-muted">Last updated: {lastUpdated}</p>
          </header>

          <hr className="border-divider mt-10" />

          <article className={`flex flex-col ${PROSE}`}>{children}</article>
        </div>
      </section>

      <Footer />
    </main>
  );
}

/** One numbered clause within a legal page. */
export function LegalSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
