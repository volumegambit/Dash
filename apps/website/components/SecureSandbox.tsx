import { SandboxVisual } from '@/components/visuals/SandboxVisual';
import { EyeOff, FileSearch, HardDrive, ShieldCheck } from 'lucide-react';

const BULLETS = [
  {
    Icon: ShieldCheck,
    title: 'Sandboxed Execution',
    description: 'Each agent runs in an isolated environment with strict permission boundaries.',
  },
  {
    Icon: HardDrive,
    title: '100% Local Data',
    description:
      'Conversations and session data stay on your computer. Nothing leaves without your explicit command.',
  },
  {
    Icon: FileSearch,
    title: 'Full Audit Trail',
    description:
      'Every action logged in append-only session files. See exactly what your agents did and why.',
  },
  {
    Icon: EyeOff,
    title: 'Zero Surveillance',
    description:
      'No tracking, no ads, no data selling. Your conversations stay between you and your agents.',
  },
];

export function SecureSandbox() {
  return (
    <section className="bg-cream py-[100px] px-8 lg:px-[160px]">
      <div className="flex flex-col lg:flex-row gap-20">
        {/* Left side */}
        <div className="flex-1 flex flex-col gap-6">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[3px] text-brand">
            BUILT FOR TRUST
          </span>

          <h2 className="font-outfit text-[32px] lg:text-[44px] font-extrabold text-text-dark tracking-tight leading-[1.1]">
            Runs on your machine.
            <br />
            Stays on your machine.
          </h2>

          <p className="text-[17px] text-text-secondary leading-relaxed">
            Your agents execute in isolated sandboxes on your own hardware. No cloud dependencies,
            no data exfiltration, full control.
          </p>

          {/* Feature bullets */}
          <div className="flex flex-col gap-4">
            {BULLETS.map(({ Icon, title, description }) => (
              <div key={title} className="flex items-start gap-3.5">
                <div className="w-10 h-10 bg-[#FFF0E8] flex items-center justify-center shrink-0">
                  <Icon size={20} className="text-brand" />
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[16px] font-semibold text-text-dark">{title}</span>
                  <span className="text-[14px] text-text-secondary leading-relaxed">
                    {description}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right side */}
        <div className="w-full lg:w-[420px] shrink-0 flex items-center justify-center">
          <SandboxVisual />
        </div>
      </div>
    </section>
  );
}
