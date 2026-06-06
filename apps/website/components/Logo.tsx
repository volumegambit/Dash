type LogoProps = {
  size?: number;
  className?: string;
};

/**
 * DashSquad brand mark: four white chevrons (the "squad") on a blue rounded
 * square. Matches the Mission Control app icon (apps/mission-control/build/icon.icns).
 */
export function Logo({ size = 28, className }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      fill="none"
      role="img"
      aria-label="DashSquad logo"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="1024" height="1024" rx="216" fill="#2563EB" />
      <path d="M315 270 L452 332.5 L315 395 L365.7 332.5 Z" fill="#fff" />
      <path d="M520 411 L683 486 L520 561 L580.3 486 Z" fill="#fff" />
      <path d="M129 436 L241 492 L129 548 L170.4 492 Z" fill="#fff" />
      <path d="M315 583 L453 645.5 L315 708 L366.1 645.5 Z" fill="#fff" />
    </svg>
  );
}
