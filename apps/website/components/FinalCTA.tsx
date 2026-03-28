import { WaitlistForm } from './WaitlistForm';

export function FinalCTA() {
  return (
    <section id="waitlist" className="bg-gradient-to-b from-brand to-brand-dark py-[120px] px-8 lg:px-[160px] flex flex-col items-center gap-8">
      <h2 className="font-outfit text-4xl lg:text-[56px] font-extrabold text-white tracking-[-3px] text-center">
        Ready to step inside?
      </h2>
      <p className="text-[20px] text-white/80 text-center">
        Be one of the first to build in Atrium. Early access is open now.
      </p>
      <WaitlistForm />
      <p className="text-[14px] text-white/50">
        Atrium is free. Limited spots available.
      </p>
    </section>
  );
}
