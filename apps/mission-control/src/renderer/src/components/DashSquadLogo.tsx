/**
 * DashSquad brand logo — orange mark + wordmark.
 * Geometry from brand guide (designs/dash.pen → Brand Identity — Logo Variations → Compact).
 */
export function DashSquadLogo({ size = 20 }: { size?: number }) {
  return (
    <div className="flex items-center gap-2">
      <svg
        width={size}
        height={size}
        viewBox="0 0 28 28"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="shrink-0"
      >
        <rect width="28" height="28" rx="6" fill="var(--color-accent)" />
        {/* Lead chevron */}
        <path d="M15 11l7 3-7 3 3-3z" fill="white" />
        {/* Top wing */}
        <path d="M9 7l6 2.5-6 2.5 2-2.5z" fill="white" />
        {/* Bottom wing */}
        <path d="M9 16l6 2.5-6 2.5 2-2.5z" fill="white" />
      </svg>
      <span className="font-[family-name:var(--font-display)] text-[15px] font-extrabold tracking-tight text-foreground">
        dashsquad
      </span>
    </div>
  );
}

/**
 * Icon-only variant for compact contexts (favicon, loading, etc.)
 */
export function DashSquadMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="28" height="28" rx="6" fill="var(--color-accent)" />
      <path d="M15 11l7 3-7 3 3-3z" fill="white" />
      <path d="M9 7l6 2.5-6 2.5 2-2.5z" fill="white" />
      <path d="M9 16l6 2.5-6 2.5 2-2.5z" fill="white" />
    </svg>
  );
}
