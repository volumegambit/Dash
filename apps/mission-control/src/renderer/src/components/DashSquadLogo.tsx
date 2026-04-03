import { Zap } from 'lucide-react';

/**
 * DashSquad sidebar logo — Zap icon + "Mission Control" wordmark.
 */
export function DashSquadLogo(): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <Zap size={18} className="text-accent" />
      <span className="font-[family-name:var(--font-display)] text-[13px] font-bold tracking-wide text-foreground">
        Mission Control
      </span>
    </div>
  );
}

/**
 * DashSquad brand mark — chevron arrows for splash/branding contexts.
 */
export function DashSquadMark({ size = 20 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 160 160"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
    >
      <title>DashSquad</title>
      <rect width="160" height="160" rx="36" fill="var(--color-accent)" />
      <path d="M81 64L107 76L81 88L91 76Z" fill="white" />
      <path d="M49 42L71 52L49 62L57 52Z" fill="white" />
      <path d="M49 91L71 101L49 111L57 101Z" fill="white" />
      <path d="M20 68L38 77L20 86L27 77Z" fill="white" />
    </svg>
  );
}
