import type { ChannelHealthEntry } from '../../../shared/ipc.js';

type ChannelHealth = ChannelHealthEntry['health'];

const COLOUR: Record<ChannelHealth, string> = {
  connected: 'bg-green',
  connecting: 'bg-yellow',
  disconnected: 'bg-red',
  needs_reauth: 'bg-red',
};

const PULSE: Record<ChannelHealth, boolean> = {
  connected: false,
  connecting: true,
  disconnected: false,
  needs_reauth: false,
};

export function HealthDot({
  health,
  className = '',
}: {
  health: ChannelHealth | null | undefined;
  className?: string;
}): JSX.Element | null {
  if (!health) return null;
  return (
    <span
      className={`inline-block h-1.5 w-1.5 rounded-full ${COLOUR[health]} ${PULSE[health] ? 'animate-pulse' : ''} ${className}`.trim()}
      title={health.replace('_', ' ')}
    />
  );
}
