/**
 * Atrium brand logo — green mark + wordmark.
 * Mark: architectural frame with leaf accent.
 */
export function AtriumLogo({ size = 20 }: { size?: number }) {
  return (
    <div className="flex items-center gap-2">
      <AtriumMark size={size} />
      <span className="font-[family-name:var(--font-display)] text-[15px] font-semibold tracking-tight text-foreground">
        atrium
      </span>
    </div>
  );
}

/**
 * Icon-only variant for compact contexts (favicon, loading, etc.)
 */
export function AtriumMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Architectural frame */}
      <rect x="2" y="2" width="24" height="24" rx="4" stroke="var(--color-accent)" strokeWidth="2" fill="none" />
      {/* Crossbeam */}
      <line x1="2" y1="10" x2="26" y2="10" stroke="var(--color-accent)" strokeWidth="1.5" />
      {/* Leaf — growth through structure */}
      <path d="M14 22C14 22 11 17 11 14C11 11 13 9 14 8C15 9 17 11 17 14C17 17 14 22 14 22Z" fill="var(--color-accent)" />
    </svg>
  );
}
